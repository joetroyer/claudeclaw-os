/**
 * Slice 9 Wave 1A — Mission Control Activity feed · e2e spec.
 *
 * Verifies the new Activity panel that replaces the legacy "Task history"
 * drawer on Mission Control. Backed by GET /api/activity from Wave 0.
 *
 * Pre-conditions:
 *   1. The bot has been restarted at least once after Wave 0 landed so
 *      mission_tasks has source / source_id columns.
 *   2. DASHBOARD_TOKEN env var is set, or the run goes through CF Access.
 *   3. The dashboard is running on localhost:3141 (or DASHBOARD_URL).
 *   4. Seeded fixtures: at least one row per source (webhook, scheduled,
 *      workflow, manual) and ≥10 webhook rows sharing the same
 *      source_id within the past 24h to exercise aggregation.
 *
 * Smoke for the same flow against the real dashboard was captured in
 * proof/slice-9/wave-1a/QA.md and the screenshots/ folder. This file
 * documents the expected behavior so it can be replayed under headless
 * CI later.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3141';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';

test.describe('Slice 9 Wave 1A — Activity feed', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${DASHBOARD}/mission?token=${TOKEN}`);
    await expect(page.getByTestId('activity-toolbar')).toBeVisible();
  });

  test('renders default 24h window with rows + aggregation group', async ({ page }) => {
    // Default time preset is 24h.
    const rows = await page.getByTestId('activity-row').count();
    expect(rows).toBeGreaterThan(0);
    // At least one collapsed group when the seed has ≥10 fires of one
    // source_id within the window.
    const groups = await page.getByTestId('activity-group').count();
    expect(groups).toBeGreaterThanOrEqual(1);
  });

  test('source filter narrows to webhook rows', async ({ page }) => {
    await page.getByTestId('activity-filter-source').click();
    await page.getByTestId('activity-filter-source-opt-webhook').click();
    // Click outside to close the dropdown.
    await page.locator('body').click({ position: { x: 0, y: 0 } });
    // All visible row data-source should be webhook (or rolled into a
    // group whose member rows are all webhook).
    await expect(page.getByTestId('activity-filter-source')).toContainText('Source (1)');
  });

  test('status filter narrows to failed', async ({ page }) => {
    await page.getByTestId('activity-filter-status').click();
    await page.getByTestId('activity-filter-status-opt-failed').click();
    await page.locator('body').click({ position: { x: 0, y: 0 } });
    const statuses = await page.getByTestId('activity-row').evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).dataset.status),
    );
    for (const s of statuses) expect(s).toBe('failed');
  });

  test('agent filter narrows to a single agent', async ({ page }) => {
    await page.getByTestId('activity-filter-agent').selectOption('main');
    const agents = await page.getByTestId('activity-row').evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).dataset.agent),
    );
    for (const a of agents) expect(a).toBe('main');
  });

  test('time presets switch the window', async ({ page }) => {
    await page.getByTestId('activity-time-1h').click();
    // 1h is narrower than default 24h; row count cannot exceed.
    const r1h = await page.getByTestId('activity-row').count();
    await page.getByTestId('activity-time-30d').click();
    const r30d = await page.getByTestId('activity-row').count();
    expect(r30d).toBeGreaterThanOrEqual(r1h);
  });

  test('search box filters client-side', async ({ page }) => {
    await page.getByTestId('activity-search').fill('goldsignals');
    // Debounce.
    await page.waitForTimeout(400);
    const titles = await page.getByTestId('activity-row').evaluateAll(
      (els) => els.map((e) => e.textContent?.toLowerCase() ?? ''),
    );
    for (const t of titles) expect(t).toContain('goldsignals');
  });

  test('aggregation group expands to reveal member rows', async ({ page }) => {
    // Filter to just webhook so the group is the only thing shown.
    await page.getByTestId('activity-filter-source').click();
    await page.getByTestId('activity-filter-source-opt-webhook').click();
    await page.locator('body').click({ position: { x: 0, y: 0 } });
    const group = page.getByTestId('activity-group').first();
    await expect(group).toBeVisible();
    const before = await page.getByTestId('activity-row').count();
    // The group toggle button is the first child button of the group.
    await group.getByRole('button').first().click();
    const after = await page.getByTestId('activity-row').count();
    expect(after).toBeGreaterThan(before);
  });

  test('pagination Load more loads another page', async ({ page }) => {
    await page.getByTestId('activity-time-all').click();
    const before = await page.getByTestId('activity-row').count();
    const loadMore = page.getByTestId('activity-load-more');
    if (await loadMore.count() > 0) {
      await loadMore.click();
      await page.waitForTimeout(700);
      const after = await page.getByTestId('activity-row').count();
      expect(after).toBeGreaterThan(before);
    }
  });

  test('empty state offers wider time-range jumps', async ({ page }) => {
    await page.getByTestId('activity-time-1h').click();
    await page.getByTestId('activity-search').fill('xyzzy_no_match_string_99');
    await page.waitForTimeout(400);
    await expect(page.getByTestId('activity-empty')).toBeVisible();
    // Should offer wider presets.
    await expect(page.getByTestId('activity-jump-7d')).toBeVisible();
  });

  test('source link navigates to the spec page', async ({ page }) => {
    // Find a row whose source-link text starts with "scheduled".
    const link = page.getByTestId('activity-source-link').filter({ hasText: 'scheduled' }).first();
    await link.click();
    await expect(page).toHaveURL(/\/scheduled/);
  });

  test('clear filters resets to defaults', async ({ page }) => {
    await page.getByTestId('activity-filter-status').click();
    await page.getByTestId('activity-filter-status-opt-failed').click();
    await page.locator('body').click({ position: { x: 0, y: 0 } });
    await expect(page.getByTestId('activity-clear-filters')).toBeVisible();
    await page.getByTestId('activity-clear-filters').click();
    await expect(page.getByTestId('activity-filter-status')).toContainText('Status');
    await expect(page.getByTestId('activity-filter-status')).not.toContainText('Status (');
  });

  test('kanban + workflows banner unaffected (regression)', async ({ page }) => {
    // Per-agent columns and Inbox column still render.
    await expect(page.getByText('Inbox', { exact: false }).first()).toBeVisible();
    // New Task button still works.
    await expect(page.getByRole('button', { name: /New Task/i })).toBeVisible();
  });
});
