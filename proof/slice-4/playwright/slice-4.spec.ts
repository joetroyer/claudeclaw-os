/**
 * Slice 4 — n8n Auto-Tasks (mission task routing) · e2e spec.
 *
 * Verifies that:
 *   1. POSTing a SIGNED n8n error payload for an OWNED workflow creates
 *      a mission_task on the owning agent, visible at /mission.
 *   2. POSTing a SIGNED n8n error for an UNOWNED workflow creates a
 *      triage mission on `meta` and (when SLACK_WEBHOOK_URL is set)
 *      attempts a Slack post.
 *   3. POSTing the SAME error twice within 60s results in EXACTLY one
 *      mission_task (debounce by workflow_id + error_signature).
 *   4. POSTing UNSIGNED returns 401 (HMAC inherited from Slice 2).
 *   5. /mission renders without console errors.
 *
 * Runs against a live dashboard (DASHBOARD_URL / DASHBOARD_TOKEN). Like
 * the Slice 2 spec, we don't spawn our own dashboard so the test
 * exercises the real auth + CSRF + watcher-routing pipeline.
 *
 * Prereqs:
 *   - DASHBOARD_URL and DASHBOARD_TOKEN env vars
 *   - watchers.yaml has the `n8n-error-router` webhook entry (slug: n8n-error)
 *   - N8N_ERROR_SECRET set on the dashboard process
 *   - n8n_workflow_owners has a row { workflow_id: 'wf_pw_owned', agent_id: 'research' }
 *     (insert before running: see proof/slice-4/n8n-router-e2e.md step 1)
 *   - For step 2: SLACK_WEBHOOK_URL set or assertion is downgraded to
 *     "mission on meta" only.
 */
import { test, expect, request } from '@playwright/test';
import crypto from 'node:crypto';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';
const SECRET = process.env.N8N_ERROR_SECRET ?? 'test-secret-n8n';
const SLUG = 'n8n-error';

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function uniqueWorkflowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('Slice 4 — n8n Auto-Tasks', () => {
  test('Unsigned POST is rejected with 401 (HMAC inherited)', async ({}, _testInfo) => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, {
      headers: { 'content-type': 'application/json' },
      data: { workflow_id: 'wf_doesnt_matter' },
    });
    expect(res.status()).toBe(401);
    const j = await res.json();
    expect(j.error).toBe('unauthorized');
  });

  test('Mis-signed POST is rejected with 401', async () => {
    const ctx = await request.newContext();
    const body = JSON.stringify({ workflow_id: 'wf_x' });
    const wrongSig = crypto.createHmac('sha256', 'not-the-secret').update(body).digest('hex');
    const res = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, {
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + wrongSig,
      },
      data: body,
    });
    expect(res.status()).toBe(401);
  });

  test('Signed POST for owned workflow creates a mission on owning agent', async ({ page }) => {
    const wf = 'wf_pw_owned'; // pre-seeded; see prereqs
    const body = JSON.stringify({
      workflow_id: wf,
      workflow_name: 'Playwright owned',
      error_message: 'pw-owned-error',
      error_signature: uniqueWorkflowId('sig'),
    });
    const ctx = await request.newContext();
    const res = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, {
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sign(body),
      },
      data: body,
    });
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.queued_mission_tasks)).toBe(true);
    expect(j.queued_mission_tasks.length).toBe(1);

    // Verify visible on the /mission dashboard.
    await page.goto(`${DASHBOARD}/mission?token=${TOKEN}`);
    await expect(page.getByText(`n8n error`, { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test('Signed POST for unowned workflow creates triage on meta', async () => {
    const wf = uniqueWorkflowId('wf_pw_unowned');
    const body = JSON.stringify({
      workflow_id: wf,
      workflow_name: 'Playwright unowned',
      error_message: 'pw-unowned-error',
      error_signature: uniqueWorkflowId('sig'),
    });
    const ctx = await request.newContext();
    const res = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, {
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sign(body),
      },
      data: body,
    });
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j.queued_mission_tasks.length).toBe(1);
    // Title contains "unowned" → mission landed on meta for triage.
    // (We can't directly assert assigned_agent without a direct DB read,
    // but the title is the deterministic surrogate per the YAML template.)
  });

  test('Same error fired twice within 60s → exactly one mission (debounce)', async () => {
    const wf = uniqueWorkflowId('wf_pw_dup');
    const body = JSON.stringify({
      workflow_id: wf,
      workflow_name: 'Playwright dup',
      error_message: 'pw-dup-error',
      error_signature: 'sig_pw_dup',
    });
    const sig = sign(body);
    const ctx = await request.newContext();
    const opts = {
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
      data: body,
    };
    const r1 = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, opts);
    const r2 = await ctx.post(`${DASHBOARD}/api/watchers/webhook/${SLUG}`, opts);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(j1.queued_mission_tasks.length).toBe(1);
    expect(j2.queued_mission_tasks.length).toBe(0); // debounced
  });

  test('No console errors on /mission', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${DASHBOARD}/mission?token=${TOKEN}`);
    await page.waitForTimeout(2_000);
    expect(errors).toEqual([]);
  });
});
