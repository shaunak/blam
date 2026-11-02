import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ponytail: one active host owns this directory; add a file lock before supporting multiple writers.
// Ten rotating files share the 1 GB budget.
export function createTelemetry(directory: string, maxBytes = 1_000_000_000) {
  const fileBytes = Math.floor(maxBytes / 10);
  let queue = Promise.resolve(), pending = 0, size = -1, failed = false;
  const path = (n: number) => join(directory, `game-${n}.jsonl`);
  return {
    write(record: object) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n';
      const bytes = Buffer.byteLength(line);
      // Drop diagnostics under disk pressure rather than stall gameplay or grow memory.
      if (bytes > Math.min(8192, fileBytes) || pending + bytes > 1_000_000 || failed) return;
      pending += bytes;
      queue = queue.then(async () => {
        if (failed) return;
        if (size < 0) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          size = await stat(path(0)).then(s => s.size, () => 0);
        }
        if (size + bytes > fileBytes) {
          await rm(path(9), { force: true });
          for (let n = 8; n >= 0; n--) {
            try { await rename(path(n), path(n + 1)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          size = 0;
        }
        await appendFile(path(0), line, { mode: 0o600 }); size += bytes;
      }).catch(() => { failed = true; console.error('[blam] Telemetry storage failed; gameplay continues.'); }).finally(() => { pending -= bytes; });
    },
    flush: () => queue,
  };
}

let writer: ReturnType<typeof createTelemetry> | undefined;
export function recordTelemetry(record: object) {
  if (!process.env.BLAM_LOG_DIR) return;
  writer ??= createTelemetry(process.env.BLAM_LOG_DIR);
  writer.write(record);
}
export async function flushTelemetry() { await writer?.flush(); }

// Accept only known fields: never persist browser URLs, SDP, IP addresses, or TURN credentials.
export function clientMetrics(data: any): Record<string, number | string | boolean> {
  const result: Record<string, number | string | boolean> = {};
  for (const key of ['rtt', 'snapshotAge', 'maxSnapshotGap', 'correction', 'pendingInputs', 'fps', 'maxFrameMs', 'browserErrors', 'shotsSent', 'shotsConfirmed', 'shotsRejected', 'stateBuffered', 'eventsBuffered', 'viewLag']) {
    if (typeof data?.[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= 1e9) result[key] = data[key];
  }
  if (['DIRECT', 'TURN RELAY', 'UNKNOWN'].includes(data?.route)) result.route = data.route;
  if (typeof data?.paused === 'boolean') result.paused = data.paused;
  if (typeof data?.hidden === 'boolean') result.hidden = data.hidden;
  return result;
}
