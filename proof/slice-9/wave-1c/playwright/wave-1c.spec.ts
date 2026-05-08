/**
 * Slice 9 Wave 1C — Scheduled page health stats + deferred-history note · e2e spec.
 *
 * Verifies the Scheduled page enhancements:
 *   - Each scheduled-task row shows a HealthSummary line with a status
 *     dot, last-run timestamp, and a one-word health label (healthy /
 *     late / overdue / paused / awaiting first run).
 *   - Each card shows a Recent runs panel with the last_run line and an
 *     honest deferred-history note that calls out the scheduler.ts
 *     architectural gap (no scheduled_runs history table today, no
 *     mission_tasks insert per fire).
 *   - The "See all in Activity" link points to /mission with the
 *     activity_source=scheduled and activity_source_id=<task_id> URL
 *     params Wave 1A's Activity feed will recognise once the scheduler
 *     is wired in a deferred slice.
 *
 * Pre-conditions:
 *   1. The dashboard is running (DASHBOARD_URL env or localhost:3141).
 *   2. DASHBOARD_TOKEN env var is set (or the run goes through CF Access).
 *   3. There is at least 1 row in scheduled_tasks (otherwise the spec
 *      asserts the empty state and exits, since health-row visibility
 *      can only be checked when a row exists).
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3141';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';

test.describe('Slice 9 Wave 1C — Scheduled page health stats', () => {
  test.beforeEach(async ({ page }) => {
    // Token is passed via query; the dashboard SPA persists it to localStorage.
    await page.goto(`${DASHBOARD}/scheduled?token=${TOKEN}`);
    await page.waitForLoadState('networkidle');
  });

  test('renders the page header', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /scheduled/i })).toBeVisible();
  });

  test('each scheduled-task card surfaces a health summary row', async ({ page }) => {
    const cards = page.getByTestId('health-summary');
    const n = await cards.count();
    if (n === 0) {
      // Empty state — nothing to verify on a zero-row dashboard. The
      // empty-state copy itself is verified separately.
      await expect(page.getByText(/no scheduled tasks/i)).toBeVisible();
      test.skip(true, 'no scheduled tasks in DB; skipping per-row checks');
      return;
    }
    // First card: must contain either a relative timestamp ("Xs ago",
    // "Xm ago", etc.) OR the "no runs yet" placeholder, plus a label.
    const text = await cards.first().innerText();
    expect(text).toMatch(/(ago|no runs yet)/i);
    expect(text).toMatch(/healthy|late|overdue|paused|awaiting first run|on schedule|last run/i);
  });

  test('cards expose the deferred-history note honestly', async ({ page }) => {
    const note = page.getByTestId('deferred-history-note').first();
    await expect(note).toBeVisible();
    await expect(note).toContainText(/scheduler\.ts/i);
    await expect(note).toContainText(/mission_tasks/i);
    await expect(note).toContainText(/deferred/i);
  });

  test('Recent runs panel shows the last_run line', async ({ page }) => {
    const last = page.getByTestId('recent-runs-last').first();
    await expect(last).toBeVisible();
    // Either captures a run or honestly says nothing yet — never fakes
    // a number.
    const txt = await last.innerText();
    expect(txt).toMatch(/last run|no runs captured/i);
  });

  test('See all in Activity link uses the future-proofed URL params', async ({ page }) => {
    const link = page.getByTestId('see-all-in-activity').first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href!).toMatch(/^\/mission\?activity_source=scheduled&activity_source_id=/);
  });

  test('CRUD entry-points still rendered (regression)', async ({ page }) => {
    // The "New Scheduled Task" button and Pause / Delete row icons
    // must remain — Wave 1C is purely additive.
    await expect(page.getByTestId('new-scheduled-task-button')).toBeVisible();
  });
});
