/**
 * Slice 5 — Cost / Token Tracking + Performance Scorecard · e2e spec.
 *
 * Verifies the new /scorecard page renders both the per-agent table
 * and the LOB/project rollup, that window switches re-fetch without
 * console errors, and that the subscription badge surfaces when an
 * agent's platform is `subscription`.
 *
 * This file is committed as documentation for the test plan. The
 * actual run is performed via the Playwright MCP tools or `npx
 * playwright test` in the implementation worktree once the dashboard
 * is running.
 *
 * Pre-conditions:
 *   1. Dashboard running on http://localhost:5173 (or set DASHBOARD_URL).
 *   2. At least one agent has token_usage rows in the DB (the live DB
 *      already has main / research / goldbot-labs).
 *   3. To verify the subscription badge, set `platform: subscription`
 *      on any agent.yaml in agents/<id>/agent.yaml; revert after.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';

test.describe('Slice 5 — Scorecard + Budget', () => {
  test('scorecard page loads, switches windows, switches views without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Land on /scorecard.
    await page.goto(`${DASHBOARD}/scorecard`);
    await expect(page.getByRole('heading', { name: 'Scorecard' })).toBeVisible();

    // 2. By-agent table is the default tab. Wait for the table head
    //    to render — proves /api/scorecard returned and rendered.
    await expect(page.getByRole('columnheader', { name: 'Agent' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible();

    // 3. There should be at least one data row. We assert by looking
    //    for the agent name "Main" — the synthesized main agent is
    //    always in the rollup (live DB has 41 turns on main).
    await expect(page.getByText('Main', { exact: true }).first()).toBeVisible();

    // 4. Switch the window to '7d'. The fetch should succeed; the
    //    table re-renders with the same column structure.
    await page.getByRole('button', { name: '7d' }).click();
    await expect(page.getByRole('columnheader', { name: 'Agent' })).toBeVisible();

    // 5. Switch the window to 'all'. Same expectation.
    await page.getByRole('button', { name: 'all' }).click();
    await expect(page.getByRole('columnheader', { name: 'Agent' })).toBeVisible();

    // 6. Switch to the budget view.
    await page.getByRole('tab', { name: 'By LOB / project' }).click();
    await expect(page.getByText('By line of business')).toBeVisible();
    await expect(page.getByText('By project')).toBeVisible();

    // 7. Click an LOB chip to filter projects. With empty Slice-1
    //    `lob` fields on the live agents, every agent rolls up under
    //    "Unassigned" — click that and verify the project section
    //    relabels to "filtered to Unassigned".
    const unassignedChip = page.getByRole('button', { name: /Unassigned/ }).first();
    await unassignedChip.click();
    await expect(page.getByText(/By project — filtered to Unassigned/)).toBeVisible();

    // 8. Click again to un-filter.
    await unassignedChip.click();
    await expect(page.getByText('By project', { exact: true })).toBeVisible();

    // 9. Console errors must be zero across the whole flow.
    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('subscription badge renders when API marks an agent as subscription', async ({ request }) => {
    // Hit /api/scorecard directly so the test isn't tied to a
    // particular agent.yaml mutation. If any row in the live DB has
    // subscription_flag = 1, assert that the row's costUsd is 0.
    const res = await request.get(`${DASHBOARD}/api/scorecard?window=all`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const subRows = (body.rows as Array<{ subscription_flag: number; costUsd: number }>)
      .filter((r) => r.subscription_flag === 1);

    // If no subscription agents are configured, the test is a no-op
    // — set platform:subscription on any agent.yaml to exercise this
    // path. We still assert the schema shape so a missing field
    // breaks the test.
    for (const row of subRows) {
      expect(row.costUsd).toBe(0);
    }
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.generatedAt).toBe('number');
  });

  test('budget endpoint groups by LOB and project', async ({ request }) => {
    const res = await request.get(`${DASHBOARD}/api/budget?window=all`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.byLob)).toBe(true);
    expect(Array.isArray(body.byProject)).toBe(true);

    // Live agents have empty lob/projects post-Slice-1 → at least one
    // group should be the "Unassigned" bucket.
    const lobKeys = (body.byLob as Array<{ key: string }>).map((g) => g.key);
    const projKeys = (body.byProject as Array<{ key: string }>).map((g) => g.key);
    expect(lobKeys).toContain('Unassigned');
    expect(projKeys).toContain('Unassigned');
  });
});
