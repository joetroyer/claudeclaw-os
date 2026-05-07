/**
 * Slice 3 — Org Chart View · e2e spec.
 *
 * Verifies that the Org Chart page renders all three tabs against the
 * live dashboard, that the LOB → project → agent hierarchy clicks
 * through cleanly, that drawers surface the Four Rs and ownership,
 * and that the page produces no console errors during the walk.
 *
 * This file is committed as documentation for the test plan. The
 * actual run is performed via the Playwright MCP tools in the
 * implementation worktree, or via `npx playwright test` once a
 * project-level config is added (Slice 3 does not introduce one to
 * keep the dependency surface flat — see proof/slice-1/playwright
 * for precedent).
 *
 * Pre-conditions for the run:
 *   1. The dashboard is running with the new routes registered
 *      (`/api/org-chart/{lobs,humans,agents,workload}` reachable).
 *   2. `lobs.yaml` and `humans.yaml` exist at the project root.
 *   3. At least one agent has `lob`, `projects`, and `four_rs.results`
 *      populated. Slice 1's migration script handles the schema; the
 *      seed values in this spec assume the agency LOB has at least
 *      one agent assigned.
 *   4. DASHBOARD_URL points at the running dashboard (default:
 *      http://localhost:3141 with a token query param, or
 *      http://localhost:5173 in dev with the Vite proxy).
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';

test.describe('Slice 3 — Org Chart View', () => {
  test('loads with three tabs', async ({ page }) => {
    await page.goto(`${DASHBOARD}/org-chart`);
    // PageHeader title.
    await expect(page.getByRole('heading', { name: /Org Chart/i })).toBeVisible();
    // Three tabs.
    await expect(page.getByRole('button', { name: /^Hierarchy$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Analytics/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Ideal vs Active/ })).toBeVisible();
  });

  test('walks the hierarchy: LOB → project → agent drawer', async ({ page }) => {
    await page.goto(`${DASHBOARD}/org-chart`);
    // Top-level LOB cards have data-testid="lob-card-<slug>".
    const firstLob = page.locator('[data-testid^="lob-card-"]').first();
    await expect(firstLob).toBeVisible();
    await firstLob.click();
    // Inside a LOB, project cards have data-testid="project-card-<slug>".
    const firstProject = page.locator('[data-testid^="project-card-"]').first();
    if (await firstProject.count() > 0) {
      await firstProject.click();
      // Inside a project, agent cards have data-testid="agent-card-<id>".
      const firstAgent = page.locator('[data-testid^="agent-card-"]').first();
      if (await firstAgent.count() > 0) {
        await firstAgent.click();
        // Drawer surfaces "Four Rs — Results".
        await expect(page.getByText(/Four Rs — Results/i)).toBeVisible({ timeout: 5_000 });
      }
    }
  });

  test('opens an agent drawer with Four Rs and ownership', async ({ page }) => {
    await page.goto(`${DASHBOARD}/org-chart`);
    // Drill straight to a project that has an agent.
    const lob = page.locator('[data-testid^="lob-card-"]').first();
    await lob.click();
    // From the LOB view, the "All resources in <LOB>" grid lists agent
    // cards directly — no need to enter a specific project.
    const firstAgent = page.locator('[data-testid^="agent-card-"]').first();
    await firstAgent.click();
    await expect(page.getByText(/Four Rs — Results/i)).toBeVisible();
    await expect(page.getByText(/Primary skills/i)).toBeVisible();
    await expect(page.getByText(/Owns/i)).toBeVisible();
  });

  test('analytics tab shows workload counts', async ({ page }) => {
    await page.goto(`${DASHBOARD}/org-chart`);
    await page.getByRole('button', { name: /^Analytics/ }).click();
    await expect(page.getByText(/Workload analytics/i)).toBeVisible();
    // At least one workload row should render (or the empty state).
    const rowsOrEmpty = page.locator('[data-testid^="workload-row-"], text=/No agents to analyze/i');
    await expect(rowsOrEmpty.first()).toBeVisible();
  });

  test('ideal vs active filter works', async ({ page }) => {
    await page.goto(`${DASHBOARD}/org-chart`);
    await page.getByRole('button', { name: /^Ideal vs Active/ }).click();
    await expect(page.getByText(/Ideal vs Active/i)).toBeVisible();
    // Filter buttons exist.
    await expect(page.getByRole('button', { name: /^All \(/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Active \(/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Ideal \(/i })).toBeVisible();
    // Switching to Ideal filter should not throw.
    await page.getByRole('button', { name: /^Ideal \(/i }).click();
  });

  test('console is clean across all three tabs', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });
    await page.goto(`${DASHBOARD}/org-chart`);
    await page.waitForSelector('h1, [class*="font-semibold"]');
    await page.getByRole('button', { name: /^Analytics/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /^Ideal vs Active/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /^Hierarchy$/ }).click();
    await page.waitForTimeout(500);
    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
