import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.argv[2];
assert.ok(url && new URL(url).hash.includes('room='), 'Pass the invite printed by npm run play.');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (let i = 0; i < 2; i++) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.locator('#options').evaluate((el: HTMLDetailsElement) => { el.open = true; });
      await page.getByLabel('Force TURN relay').check();
    await page.getByRole('button', { name: 'Join Game' }).click();
    await page.getByRole('button', { name: 'Enter arena' }).waitFor({ timeout: 30000 });
    await page.getByText(/TURN RELAY/).waitFor({ timeout: 10000 });
  }
  console.log('PASS: both browsers joined the public session through TURN.');
} finally { await browser.close(); }
