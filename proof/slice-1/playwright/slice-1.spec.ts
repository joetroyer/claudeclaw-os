/**
 * Slice 1 — Agent Schema Upgrade · e2e spec.
 *
 * Verifies that the AgentFiles UI renders the migrated YAML, that a
 * Slice-1 field can be edited and persisted, and that the persona
 * (CLAUDE.md) tab loads independently. The Monaco editor is the
 * existing renderer — there is no new UI component for this slice.
 *
 * This file is committed as documentation for the test plan. The
 * actual run is performed via the Playwright MCP tools in the
 * implementation worktree (mcp__plugin_playwright_playwright__*).
 *
 * Pre-conditions for the run:
 *   1. Migration has been applied to the agents/ directory the
 *      dashboard is reading from (worktree dir for development; the
 *      production agents/ dir for staging).
 *   2. The `clawds` agent exists with a Slice-1-migrated agent.yaml.
 *   3. The dashboard is running (npm run dev:web on http://localhost:5173
 *      or the production URL).
 *   4. The Cloudflare tunnel / port-forward is up if testing via
 *      clawos.joetroyer.com.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5173';
const AGENT = 'clawds';

test.describe('Slice 1 — Agent Schema Upgrade', () => {
  test('persona tab loads, config tab loads, new field round-trips', async ({ page }) => {
    // 1. Navigate to the agent's Files page.
    await page.goto(`${DASHBOARD}/agents/${AGENT}/files`);

    // 2. Persona tab is the default. Confirm it loaded — Monaco is
    //    lazy-imported, so we wait for the editor's textarea before
    //    asserting content.
    await expect(page.getByRole('button', { name: /Persona \(CLAUDE\.md\)/ })).toBeVisible();
    await page.waitForSelector('.monaco-editor', { timeout: 15_000 });
    const personaText = await page.evaluate(() =>
      // Monaco exposes the model on the global; reading it avoids
      // brittle DOM-text assertions on the rendered tokens.
      (window as any).monaco?.editor?.getModels()?.[0]?.getValue() ?? ''
    );
    expect(personaText).toMatch(/Clawds|Google Ads/);

    // 3. Switch to the Config tab.
    await page.getByRole('button', { name: /Config \(agent\.yaml\)/ }).click();
    await page.waitForFunction(
      () => (window as any).monaco?.editor?.getModels()?.[0]?.getValue()?.includes('telegram_bot_token_env'),
      { timeout: 10_000 }
    );

    // 4. Confirm the migrated Slice-1 fields are present in the YAML.
    const before = await page.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    );
    expect(before).toContain('four_rs:');
    expect(before).toContain('owns:');
    expect(before).toContain('platform:');
    expect(before).toContain('skills:');
    expect(before).toContain('avatar:');

    // 5. Edit a Slice-1 field. We add a single primary skill — the
    //    YAML parser tolerates the change, the loader ignores
    //    skills.primary today, and the round-trip back to disk is
    //    the actual thing under test.
    const edited = before.replace(/(skills:\s*\n\s*primary:\s*\[\])/, 'skills:\n  primary: [google-ads-audit]');
    expect(edited).not.toEqual(before);
    await page.evaluate((content: string) => {
      (window as any).monaco.editor.getModels()[0].setValue(content);
    }, edited);

    // 6. Save.
    await page.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText(/Config saved/i)).toBeVisible({ timeout: 5_000 });

    // 7. Reload the page and confirm the edit persisted.
    await page.reload();
    await page.getByRole('button', { name: /Config \(agent\.yaml\)/ }).click();
    await page.waitForFunction(
      () => (window as any).monaco?.editor?.getModels()?.[0]?.getValue()?.includes('google-ads-audit'),
      { timeout: 10_000 }
    );
    const after = await page.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    );
    expect(after).toContain('google-ads-audit');

    // 8. Cleanup — restore the field to empty so reruns are stable.
    const cleaned = after.replace(/skills:\s*\n\s*primary:\s*\[google-ads-audit\]/, 'skills:\n  primary: []');
    await page.evaluate((content: string) => {
      (window as any).monaco.editor.getModels()[0].setValue(content);
    }, cleaned);
    await page.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText(/Config saved/i)).toBeVisible({ timeout: 5_000 });
  });

  test('console is clean during the round trip', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto(`${DASHBOARD}/agents/${AGENT}/files`);
    await page.waitForSelector('.monaco-editor', { timeout: 15_000 });
    await page.getByRole('button', { name: /Config \(agent\.yaml\)/ }).click();
    await page.waitForFunction(
      () => (window as any).monaco?.editor?.getModels()?.[0]?.getValue()?.length > 0,
      { timeout: 10_000 }
    );
    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
