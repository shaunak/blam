import timers from 'node:timers/promises';

export async function waitForTunnelFailure(origin: string, signal: AbortSignal) {
  let failures = 0;
  while (!signal.aborted) {
    try { await timers.setTimeout(30000, undefined, { signal }); } catch { return; }
    let healthy = false;
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      healthy = response.ok && await response.text() === 'ok';
    } catch {}
    if (signal.aborted) return;
    failures = healthy ? 0 : failures + 1;
    if (failures >= 3) return;
  }
}
