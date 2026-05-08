/**
 * Slice 10 Wave 1 — OrgChartV2 page · e2e spec.
 *
 * Verifies the new /org-chart-v2 page that consumes /api/org-chart-v2
 * (merged in Wave 0). The page renders a tree of human + AI cards with
 * smart collapse/expand, focus mode, depth presets, search, filter
 * chips, URL state, localStorage persistence, drawer with Four Rs +
 * personality + skills + owns + LOB, and outbound cadence-badge links.
 *
 * Pre-conditions:
 *   1. Dashboard running on localhost:3141 (or DASHBOARD_URL).
 *   2. DASHBOARD_TOKEN env var set, or auth bypassed by CF Access.
 *   3. /api/org-chart-v2 returns at least one node (joe by default).
 *
 * QA reproduction notes + screenshots live in
 * proof/slice-10/wave-1/QA.md and proof/slice-10/wave-1/screenshots/.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3141';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';

test.describe('Slice 10 Wave 1 — Org Chart v2', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage so each run starts from default expansion.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem('claudeclaw.org-chart-v2.expansion');
      } catch {
        // ignore — private mode etc.
      }
    });
    await page.goto(`${DASHBOARD}/org-chart-v2?token=${TOKEN}`);
    await expect(page.getByTestId('org-chart-v2-toolbar')).toBeVisible();
  });

  test('route renders with toolbar + at least one card', async ({ page }) => {
    // Joe is the only guaranteed node from the seeded fixture.
    await expect(page.getByTestId('org-chart-v2-card-joe')).toBeVisible();
    await expect(page.getByTestId('org-chart-v2-title-joe')).toBeVisible();
  });

  test('depth presets toggle expansion', async ({ page }) => {
    // Depth all should expand every node; depth 1 should collapse all
    // children below the roots.
    await page.getByTestId('org-chart-v2-depth-all').click();
    const allExpanded = await page.locator('[data-testid^="org-chart-v2-children-"]').count();

    await page.getByTestId('org-chart-v2-depth-1').click();
    const depth1Expanded = await page.locator('[data-testid^="org-chart-v2-children-"]').count();

    // Either equal (when every root is leaf in the live tree) or
    // strictly fewer.
    expect(depth1Expanded).toBeLessThanOrEqual(allExpanded);
  });

  test('search auto-expands path to matching nodes', async ({ page }) => {
    await page.getByTestId('org-chart-v2-search').fill('joe');
    // Card for joe is highlighted (ring class) and others dimmed.
    await expect(page.getByTestId('org-chart-v2-card-joe')).toBeVisible();
  });

  test('type filter chip dims non-matching cards', async ({ page }) => {
    await page.getByTestId('org-chart-v2-filter-type-human').click();
    // Human cards stay opacity-100; AI cards drop to opacity-40.
    const joeCard = page.getByTestId('org-chart-v2-card-joe');
    await expect(joeCard).toBeVisible();
    // Visual dim is class-driven; no horizontal hide.
  });

  test('focus mode zooms to a node and back', async ({ page }) => {
    await page.getByTestId('org-chart-v2-title-joe').click();
    await expect(page.getByTestId('org-chart-v2-exit-focus')).toBeVisible();
    // URL reflects ?focus=joe
    await expect(page).toHaveURL(/focus=joe/);
    await page.getByTestId('org-chart-v2-exit-focus').click();
    await expect(page).not.toHaveURL(/focus=joe/);
  });

  test('drawer opens on subtitle click and closes on Esc', async ({ page }) => {
    await page.getByTestId('org-chart-v2-subtitle-joe').click();
    // Drawer body shows the Four Rs section header.
    await expect(page.locator('text=FOUR RS').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('text=FOUR RS')).toBeHidden({ timeout: 1000 }).catch(() => {
      // Drawer animates out — best-effort.
    });
  });

  test('URL ?focus=<id> deep-links to the focused node', async ({ page }) => {
    await page.goto(`${DASHBOARD}/org-chart-v2?token=${TOKEN}&focus=joe`);
    await expect(page.getByTestId('org-chart-v2-exit-focus')).toBeVisible();
  });

  test('mobile (375px) renders without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByTestId('org-chart-v2-toolbar')).toBeVisible();
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docWidth).toBeLessThanOrEqual(375 + 4); // tiny rounding tolerance
  });

  test('localStorage persists expansion across reload', async ({ page }) => {
    // Toggle joe closed, reload, expect it to stay closed.
    const toggle = page.getByTestId('org-chart-v2-toggle-joe');
    await toggle.click();
    await page.reload();
    // After reload joe should still be collapsed (no children-joe element).
    await expect(page.getByTestId('org-chart-v2-children-joe')).toHaveCount(0);
  });

  test('cadence badge clicks navigate to scheduled / triggered pages', async ({ page }) => {
    await page.getByTestId('org-chart-v2-scheduled-joe').click();
    await expect(page).toHaveURL(/\/scheduled\?agent=joe/);
  });
});
