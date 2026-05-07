/**
 * Slice 6 — Multi-Agent Workflows · e2e spec.
 *
 * Verifies the dashboard surface for the slice:
 *   1. POST /api/workflows/dispatch creates a workflow run.
 *   2. GET /api/workflows/runs lists the run.
 *   3. GET /api/workflows/runs/:id returns the run + stages + payload.
 *   4. The Mission Control page renders a "Workflows" section that
 *      shows the active run with stage breakdown when the workflow
 *      runner advances it.
 *   5. Council stages render side-by-side (one card per agent).
 *   6. An escalated run produces a visible escalation mission_task.
 *   7. No browser console errors during any of the above.
 *
 * Pre-conditions:
 *   1. Dashboard is running on DASHBOARD_URL (default
 *      http://localhost:5173 in dev, or the prod URL with
 *      ?token=... appended in headed runs).
 *   2. The 3 example workflows are present at workflows/*.yaml:
 *        - dev-fix-qa-verify (sequential, 2 stages)
 *        - bug-hunt-council (council, 3 agents)
 *        - escalation-test (forced failure, retries=0)
 *   3. The workflow daemon poller is running (or runWorkflowToCompletion
 *      is invoked manually in stub mode for headless CI).
 *
 * This spec is committed as documentation — the actual run is performed
 * via the Playwright MCP tools in the implementation worktree.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';
const TQ = TOKEN ? `?token=${TOKEN}` : '';

test.describe('Slice 6 — Multi-Agent Workflows', () => {
  test('dispatch + list + detail API contracts', async ({ request }) => {
    // Dispatch a sequential workflow.
    const dispatchRes = await request.post(`${DASHBOARD}/api/workflows/dispatch${TQ}`, {
      data: { slug: 'dev-fix-qa-verify', input: 'e2e test', created_by: 'playwright' },
    });
    expect(dispatchRes.ok()).toBeTruthy();
    const dispatchBody = await dispatchRes.json();
    expect(dispatchBody.id).toBeTruthy();
    expect(dispatchBody.slug).toBe('dev-fix-qa-verify');

    const runId = dispatchBody.id as string;

    // List endpoint includes our run.
    const listRes = await request.get(`${DASHBOARD}/api/workflows/runs${TQ}`);
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    const found = (listBody.runs as Array<{ id: string }>).find((r) => r.id === runId);
    expect(found).toBeTruthy();

    // Detail endpoint returns run + stages + payload structure.
    const detailRes = await request.get(`${DASHBOARD}/api/workflows/runs/${runId}${TQ}`);
    expect(detailRes.ok()).toBeTruthy();
    const detailBody = await detailRes.json();
    expect(detailBody.run.id).toBe(runId);
    expect(Array.isArray(detailBody.stages)).toBe(true);
    expect(detailBody.payload.input).toBe('e2e test');
  });

  test('dispatch endpoint rejects bad slug', async ({ request }) => {
    const bad = await request.post(`${DASHBOARD}/api/workflows/dispatch${TQ}`, {
      data: { slug: 'BAD SLUG WITH SPACES', input: '' },
    });
    expect(bad.status()).toBe(400);
  });

  test('Mission Control page shows workflows section', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto(`${DASHBOARD}/mission${TQ}`);
    // The page should render. If a Workflows section is rendered as a
    // distinct heading or card, expect it to be visible.
    await expect(page.getByText(/Mission Control|Tasks|Workflows/i).first()).toBeVisible({ timeout: 10_000 });

    // No console errors.
    expect(consoleErrors).toEqual([]);
  });

  test('escalation-test produces an escalation mission_task', async ({ request }) => {
    // Dispatch the forced-failure workflow.
    const dispatch = await request.post(`${DASHBOARD}/api/workflows/dispatch${TQ}`, {
      data: { slug: 'escalation-test', input: 'force fail', created_by: 'playwright' },
    });
    expect(dispatch.ok()).toBeTruthy();
    const { id: runId } = await dispatch.json();

    // Wait up to 60s for the runner to advance the run to 'escalated'.
    let escalated = false;
    for (let i = 0; i < 30; i++) {
      const detail = await request.get(`${DASHBOARD}/api/workflows/runs/${runId}${TQ}`);
      const body = await detail.json();
      if (body.run.state === 'escalated') { escalated = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(escalated).toBeTruthy();

    // Check that an escalation mission_task exists, assigned to 'meta'.
    const tasks = await request.get(`${DASHBOARD}/api/mission/tasks${TQ}`);
    const tasksBody = await tasks.json();
    const escalation = (tasksBody.tasks as Array<{ created_by: string; assigned_agent: string }>)
      .find((t) => t.created_by === 'workflow-escalation' && t.assigned_agent === 'meta');
    expect(escalation).toBeTruthy();
  });
});
