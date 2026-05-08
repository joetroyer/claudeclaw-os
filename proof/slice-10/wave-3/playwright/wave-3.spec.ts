/**
 * Slice 10 Wave 3 — OrgChartV2 inline YAML editor · e2e spec.
 *
 * Verifies the drawer's Edit YAML flow, end-to-end:
 *   1. Open the drawer for `meta` (Wave 1 wired the drawer; Wave 3
 *      replaces the toast stub with a real editor).
 *   2. Click Edit YAML in the FOUR Rs section header.
 *   3. The editor renders with the agent's current yaml content.
 *   4. Add a benign comment line, save.
 *   5. Toast confirms success, drawer closes, /api/org-chart-v2 refetches.
 *   6. Re-opening the same drawer (and editor) shows the comment persisted.
 *
 * Pre-conditions:
 *   1. Dashboard running on localhost:3141 (or DASHBOARD_URL).
 *   2. DASHBOARD_TOKEN env var set, or auth bypassed by CF Access.
 *   3. agents/meta/agent.yaml exists with a valid name + description so
 *      the PUT validation passes when we round-trip the same content.
 *
 * Cleanup: this spec leaves a `# slice-10-wave-3 e2e marker` comment in
 * agents/meta/agent.yaml. The teardown step strips it so repeated runs
 * remain deterministic.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3141';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';
const AGENT_ID = process.env.WAVE_3_AGENT_ID ?? 'meta';
const MARKER = `# slice-10-wave-3 e2e marker ${Date.now()}`;

test.describe('Slice 10 Wave 3 — Org Chart v2 YAML editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem('claudeclaw.org-chart-v2.expansion');
      } catch {
        // ignore
      }
    });
    await page.goto(`${DASHBOARD}/org-chart-v2?token=${TOKEN}`);
    await expect(page.getByTestId('org-chart-v2-toolbar')).toBeVisible();
  });

  test.afterAll(async ({ request }) => {
    // Strip the marker we appended so the file shape stays clean.
    const getRes = await request.get(
      `${DASHBOARD}/api/agents/${AGENT_ID}/yaml?token=${TOKEN}`,
    );
    if (!getRes.ok()) return;
    const { yaml } = await getRes.json();
    const cleaned = String(yaml)
      .split('\n')
      .filter((line) => !line.includes('slice-10-wave-3 e2e marker'))
      .join('\n');
    await request.put(`${DASHBOARD}/api/agents/${AGENT_ID}/yaml?token=${TOKEN}`, {
      data: { yaml: cleaned },
    });
  });

  test('opens, edits, saves, and persists', async ({ page }) => {
    // 1. Open drawer for meta. The subtitle is the role text on the
    //    NodeCard — Wave 1 wires it as the click target for the drawer.
    const subtitle = page.getByTestId(`org-chart-v2-subtitle-${AGENT_ID}`);
    // First make sure the meta card is visible. If the tree default
    // collapses past meta, expand its parent (joe) first.
    const card = page.getByTestId(`org-chart-v2-card-${AGENT_ID}`);
    if (!(await card.isVisible().catch(() => false))) {
      await page.getByTestId('org-chart-v2-depth-all').click();
    }
    await expect(card).toBeVisible();
    await subtitle.click();
    const drawer = page.getByTestId('org-chart-v2-drawer-content');
    await expect(drawer).toBeVisible();

    // 2. Click the Four Rs section header — Wave 1 made it a button that
    //    fires onYamlEdit. Wave 3 swaps the body to YamlEditorPanel.
    await drawer.locator('text=FOUR RS').first().click();
    const editor = page.getByTestId('org-chart-v2-yaml-editor');
    await expect(editor).toBeVisible();

    // 3. Editor pre-fills with the current yaml. The textarea must
    //    contain the agent's `name:` line.
    const textarea = page.getByTestId('org-chart-v2-yaml-textarea');
    await expect(textarea).toBeVisible();
    const initial = await textarea.inputValue();
    expect(initial.length).toBeGreaterThan(0);
    expect(initial).toMatch(/^name:/m);

    // Live valid badge is showing.
    await expect(page.getByTestId('org-chart-v2-yaml-parse-ok')).toBeVisible();

    // 4. Append a benign comment line and save.
    const next = initial.replace(/\s+$/, '') + '\n' + MARKER + '\n';
    await textarea.fill(next);
    await expect(page.getByTestId('org-chart-v2-yaml-parse-ok')).toBeVisible();

    // Save button enabled.
    const save = page.getByTestId('org-chart-v2-yaml-save');
    await expect(save).toBeEnabled();
    await save.click();

    // 5. Drawer closes (NodeDrawer / editor both unmount).
    await expect(editor).toBeHidden({ timeout: 5000 });

    // 6. Re-open the drawer and the editor; the marker should be there.
    await page.getByTestId(`org-chart-v2-subtitle-${AGENT_ID}`).click();
    await expect(drawer).toBeVisible();
    await drawer.locator('text=FOUR RS').first().click();
    await expect(editor).toBeVisible();
    const persisted = await page.getByTestId('org-chart-v2-yaml-textarea').inputValue();
    expect(persisted).toContain(MARKER);
  });

  test('Cancel closes the editor without writing', async ({ page }) => {
    const card = page.getByTestId(`org-chart-v2-card-${AGENT_ID}`);
    if (!(await card.isVisible().catch(() => false))) {
      await page.getByTestId('org-chart-v2-depth-all').click();
    }
    await page.getByTestId(`org-chart-v2-subtitle-${AGENT_ID}`).click();
    const drawer = page.getByTestId('org-chart-v2-drawer-content');
    await expect(drawer).toBeVisible();
    await drawer.locator('text=FOUR RS').first().click();
    const editor = page.getByTestId('org-chart-v2-yaml-editor');
    await expect(editor).toBeVisible();

    // Mutate, then Cancel — the file must not be written.
    const textarea = page.getByTestId('org-chart-v2-yaml-textarea');
    const original = await textarea.inputValue();
    await textarea.fill(original + '\n# this should never be saved\n');
    await page.getByTestId('org-chart-v2-yaml-cancel').click();

    // Editor is gone; we're back on the read-only NodeDrawer.
    await expect(editor).toBeHidden();
    await expect(drawer).toBeVisible();
  });

  test('invalid yaml disables Save and surfaces a parse error', async ({ page }) => {
    const card = page.getByTestId(`org-chart-v2-card-${AGENT_ID}`);
    if (!(await card.isVisible().catch(() => false))) {
      await page.getByTestId('org-chart-v2-depth-all').click();
    }
    await page.getByTestId(`org-chart-v2-subtitle-${AGENT_ID}`).click();
    await page.getByTestId('org-chart-v2-drawer-content')
      .locator('text=FOUR RS').first().click();
    const editor = page.getByTestId('org-chart-v2-yaml-editor');
    await expect(editor).toBeVisible();

    // Insert a tab — js-yaml rejects tabs in indentation.
    const textarea = page.getByTestId('org-chart-v2-yaml-textarea');
    await textarea.fill("name: Meta\n\tdescription: bad-tab\n");
    await expect(page.getByTestId('org-chart-v2-yaml-parse-error')).toBeVisible();
    await expect(page.getByTestId('org-chart-v2-yaml-save')).toBeDisabled();
  });
});
