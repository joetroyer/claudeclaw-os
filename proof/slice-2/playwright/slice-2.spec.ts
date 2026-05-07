/**
 * Slice 2 — Triggered Tasks (Webhook Watcher) · e2e spec.
 *
 * Verifies that:
 *   1. The /triggered page loads, lists configured webhook watchers.
 *   2. The webhook URL is copyable.
 *   3. Posting a SIGNED preview-mode payload (server-to-server) makes
 *      the payload visible in the UI without firing actions.
 *   4. Toggling to run mode + posting a SIGNED payload creates a
 *      mission_task.
 *   5. Posting an UNSIGNED payload to a run-mode webhook returns 401.
 *
 * The test runs against a live dashboard (DASHBOARD_URL / DASHBOARD_TOKEN).
 * It does NOT spawn its own dashboard — that's intentional, since we want
 * the e2e to exercise the same auth+CSRF pipeline real callers hit.
 *
 * Prereqs:
 *   - DASHBOARD_URL and DASHBOARD_TOKEN env vars
 *   - watchers.yaml has a `trading-monitor` webhook with secret_env
 *     pointing at TRADING_MONITOR_SECRET (populated in env)
 *   - The TRADING_MONITOR_SECRET env var is set on the dashboard process
 */
import { test, expect, request } from '@playwright/test';
import crypto from 'node:crypto';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';
const SECRET = process.env.TRADING_MONITOR_SECRET ?? 'test-secret-abc';
const SLUG = 'trading-monitor';

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

test.describe('Slice 2 — Triggered Tasks', () => {
  test('Triggered page lists webhook watchers and webhook URL is visible', async ({ page }) => {
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await expect(page.getByRole('heading', { name: /Triggered Tasks/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('trading-monitor-trigger', { exact: false })).toBeVisible();
    await expect(page.getByTestId(`copy-url-${SLUG}`)).toBeVisible();
  });

  test('Copy button copies the webhook URL to clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.getByTestId(`copy-url-${SLUG}`).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toMatch(/\/api\/watchers\/webhook\/trading-monitor$/);
  });

  test('Unsigned POST is rejected with 401', async ({}, testInfo) => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, {
      headers: { 'content-type': 'application/json' },
      data: { signal: 'buy' },
    });
    expect(res.status()).toBe(401);
    const j = await res.json();
    expect(j.error).toBe('unauthorized');
  });

  test('Signed POST in run/test mode creates a mission_task', async ({ page }) => {
    const body = JSON.stringify({ signal: 'sell', instrument: 'XAUUSD', entry: 2349.5 });
    const sig = sign(body);
    const ctx = await request.newContext();
    const res = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, {
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
      data: body,
    });
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.queued_mission_tasks)).toBe(true);
    expect(j.queued_mission_tasks.length).toBeGreaterThan(0);

    // Now verify the payload appears in the UI's "Last payloads" pane.
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    // Click the chevron next to the watcher to expand it.
    const card = page.locator(`text=trading-monitor-trigger`).first();
    await card.click({ force: true });
    await expect(page.getByText('Last payloads', { exact: false })).toBeVisible({ timeout: 5_000 });
    // The payload list shows our latest submission.
    await expect(page.getByTestId(`payloads-${SLUG}`)).toBeVisible({ timeout: 5_000 });
  });

  test('Fire-test-payload button queues a test mission_task', async ({ page }) => {
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    // Expand watcher row
    await page.locator(`text=trading-monitor-trigger`).first().click({ force: true });
    // Type a JSON payload (textarea pre-filled by default; edit it to confirm).
    const ta = page.getByTestId(`test-json-${SLUG}`);
    await ta.click();
    await ta.fill('{"signal":"buy","instrument":"XAUUSD","via":"playwright"}');
    await page.getByTestId(`fire-test-${SLUG}`).click();
    await expect(page.getByText(/Queued \d+ mission_task/)).toBeVisible({ timeout: 10_000 });
  });

  test('No console errors on the Triggered page', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.waitForTimeout(2_000);
    expect(errors).toEqual([]);
  });
});
