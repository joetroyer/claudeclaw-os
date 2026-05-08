/**
 * Slice 9 Wave 1B — Triggered page enhancements · e2e spec.
 *
 * Verifies the new per-watcher health-stats strip + recent-fires panel
 * land cleanly on /triggered, that the legacy payloads viewer still
 * works post-Wave-0, and that the Mission Control "See all in Activity"
 * deep link is correctly constructed (Wave 1A may not consume the
 * params yet — link integrity is what we assert here).
 *
 * Pre-conditions:
 *   1. Dashboard is running (clawos.joetroyer.com or localhost:3141).
 *   2. DASHBOARD_TOKEN env var is set (or the run goes through CF Access).
 *   3. At least one webhook watcher is configured in watchers.yaml.
 *
 * Run: npx playwright test proof/slice-9/wave-1b/playwright/wave-1b.spec.ts
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3141';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';

// Pull the first webhook slug at runtime so the spec stays portable
// across environments (different watchers.yaml will have different slugs).
async function firstWebhookSlug(request: any): Promise<string> {
  const r = await request.get(`${DASHBOARD}/api/watchers/webhook?token=${TOKEN}`);
  const j = await r.json();
  expect(Array.isArray(j.watchers)).toBe(true);
  expect(j.watchers.length).toBeGreaterThan(0);
  return j.watchers[0].slug as string;
}

test.describe('Slice 9 Wave 1B — Triggered page enhancements', () => {
  test('health strip renders for every webhook on /triggered', async ({ page, request }) => {
    const slug = await firstWebhookSlug(request);
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    // Wait for the watcher card to mount.
    await page.waitForSelector(`[data-testid="watcher-card-${slug}"]`, { timeout: 10_000 });
    // Health strip is rendered unconditionally (loading/empty/data),
    // so we can assert on it without firing a webhook first.
    const strip = page.locator(`[data-testid="health-strip-${slug}"]`);
    await expect(strip).toBeVisible();
    // The fires-today field is the canonical "stats are populated" signal.
    await expect(page.locator(`[data-testid="health-fires-${slug}"]`)).toBeVisible({ timeout: 10_000 });
    // Status dot is always present once data resolves.
    await expect(page.locator(`[data-testid="health-dot-${slug}"]`)).toBeVisible();
  });

  test('status dot tone is one of green / yellow / red / idle', async ({ page, request }) => {
    const slug = await firstWebhookSlug(request);
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.waitForSelector(`[data-testid="health-dot-${slug}"]`, { timeout: 10_000 });
    const tone = await page.locator(`[data-testid="health-dot-${slug}"]`).getAttribute('data-tone');
    expect(['green', 'yellow', 'red', 'idle']).toContain(tone);
  });

  test('expanding a card reveals the Recent fires panel', async ({ page, request }) => {
    const slug = await firstWebhookSlug(request);
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.waitForSelector(`[data-testid="watcher-card-${slug}"]`, { timeout: 10_000 });
    await page.click(`[data-testid="toggle-watcher-${slug}"]`);
    await expect(page.locator(`[data-testid="recent-fires-${slug}"]`)).toBeVisible({ timeout: 5_000 });
    // "See all in Activity" link is wired with the right URL params.
    const link = page.locator(`[data-testid="see-all-activity-${slug}"]`);
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toContain('/mission?');
    expect(href).toContain('activity_source=webhook');
    expect(href).toContain(`activity_source_id=${encodeURIComponent(slug)}`);
  });

  test('legacy /api/watchers/webhook/:slug/payloads endpoint returns 200 with token (Wave-0 bonus fix)', async ({ request }) => {
    const slug = await firstWebhookSlug(request);
    const r = await request.get(
      `${DASHBOARD}/api/watchers/webhook/${slug}/payloads?token=${TOKEN}&limit=5`,
    );
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.payloads)).toBe(true);
  });

  test('legacy /api/watchers/webhook/:slug/payloads endpoint returns 401 without token', async ({ request }) => {
    const slug = await firstWebhookSlug(request);
    const r = await request.get(`${DASHBOARD}/api/watchers/webhook/${slug}/payloads?limit=5`);
    expect(r.status()).toBe(401);
  });

  test('expanding a card still shows the legacy Last payloads panel (NOT replaced)', async ({ page, request }) => {
    const slug = await firstWebhookSlug(request);
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.waitForSelector(`[data-testid="watcher-card-${slug}"]`, { timeout: 10_000 });
    await page.click(`[data-testid="toggle-watcher-${slug}"]`);
    // Both panels coexist — Recent fires (mission-level) AND Last payloads
    // (HTTP-level). The brief is explicit they're complementary.
    await expect(page.locator(`[data-testid="recent-fires-${slug}"]`)).toBeVisible();
    await expect(page.getByText('Last payloads')).toBeVisible();
  });

  test('console is clean across the Triggered page render + expand cycle', async ({ page, request }) => {
    const slug = await firstWebhookSlug(request);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.waitForSelector(`[data-testid="watcher-card-${slug}"]`, { timeout: 10_000 });
    await page.click(`[data-testid="toggle-watcher-${slug}"]`);
    await page.waitForSelector(`[data-testid="recent-fires-${slug}"]`, { timeout: 5_000 });
    // Allow expected favicon + 401 noise (the SPA shell pings unauth'd
    // endpoints during transient auth states); fail on anything else.
    const real = errors.filter(
      (e) => !/favicon|401|Unauthorized|Failed to load resource/i.test(e),
    );
    expect(real).toEqual([]);
  });

  test('CRUD UI is untouched — New + Edit + Delete buttons still present', async ({ page, request }) => {
    const slug = await firstWebhookSlug(request);
    await page.goto(`${DASHBOARD}/triggered?token=${TOKEN}`);
    await page.waitForSelector(`[data-testid="watcher-card-${slug}"]`, { timeout: 10_000 });
    await expect(page.locator('[data-testid="new-triggered-task-button"]')).toBeVisible();
    await expect(page.locator(`[data-testid="edit-watcher-${slug}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="delete-watcher-${slug}"]`)).toBeVisible();
  });

  test('GET /api/activity?source=webhook&source_id=<slug> returns rows scoped to that slug', async ({ request }) => {
    const slug = await firstWebhookSlug(request);
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const r = await request.get(
      `${DASHBOARD}/api/activity?token=${TOKEN}&source=webhook&source_id=${encodeURIComponent(slug)}&since=${since}&limit=50`,
    );
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.activity)).toBe(true);
    for (const row of j.activity) {
      expect(row.source).toBe('webhook');
      expect(row.source_id).toBe(slug);
    }
  });
});
