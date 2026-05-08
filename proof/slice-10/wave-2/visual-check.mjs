// One-shot visual check for the Wave 2 OrgChartV2 polish.
// Mocks /api/org-chart-v2 with a representative payload, drives the
// Vite dev server at :5173, captures screenshots at 1280px and 375px.
// Not a CI artefact — run by hand to eyeball the new card.
//
// Usage:
//   npm run dev:web        # in one terminal
//   node proof/slice-10/wave-2/visual-check.mjs
//
// Requires `playwright` (npm i -D playwright + chromium download).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');

const NODES = [
  {
    id: 'joe', type: 'human', name: 'Joe', role: 'Founder & operator',
    reports_to: null, lob: null, projects: [],
    skills: { primary: [] },
    owns: { scheduled_tasks: [], triggered_tasks: [], n8n_workflows: [], watchers: [] },
    four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
    personality: { tone: '', pushback: '', format: '' },
    avatar: null, running: null, today_turns: null,
    scheduled_count: 0, triggered_count: 0,
  },
  {
    id: 'meta', type: 'ai', name: 'Meta', role: 'Strategist for the agency LOB. Owns prioritisation, agents under it, and weekly sync.',
    reports_to: 'joe', lob: 'agency', projects: ['acme', 'glth'],
    skills: { primary: ['planning', 'prioritisation', 'roadmap', 'okrs', 'okr-tracking'] },
    owns: { scheduled_tasks: ['weekly-sync'], triggered_tasks: ['inbox-triage'], n8n_workflows: ['agency-rollup'], watchers: [] },
    four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
    personality: { tone: '', pushback: '', format: '' },
    avatar: null, running: true, today_turns: 4,
    scheduled_count: 3, triggered_count: 1,
  },
  {
    id: 'comms', type: 'ai', name: 'Comms', role: 'All human communication — email, Slack, WhatsApp, YouTube comments, community forums, LinkedIn DMs.',
    reports_to: 'meta', lob: 'agency', projects: [],
    skills: { primary: ['gmail', 'slack', 'whatsapp'] },
    owns: { scheduled_tasks: ['daily-digest'], triggered_tasks: [], n8n_workflows: [], watchers: [] },
    four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
    personality: { tone: '', pushback: '', format: '' },
    avatar: null, running: true, today_turns: 12,
    scheduled_count: 1, triggered_count: 0,
  },
  {
    id: 'content', type: 'ai', name: 'Content', role: 'Long-form writing — blog posts, emails, scripts.',
    reports_to: 'meta', lob: 'agency', projects: [],
    skills: { primary: ['copywriting', 'seo'] },
    owns: { scheduled_tasks: [], triggered_tasks: [], n8n_workflows: [], watchers: [] },
    four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
    personality: { tone: '', pushback: '', format: '' },
    avatar: null, running: false, today_turns: 0,
    scheduled_count: 0, triggered_count: 0,
  },
  {
    id: 'research', type: 'ai', name: 'Research', role: 'Deep web research, academic sources, competitive intel.',
    reports_to: 'meta', lob: 'agency', projects: [],
    skills: { primary: ['web-research', 'gws'] },
    owns: { scheduled_tasks: [], triggered_tasks: [], n8n_workflows: [], watchers: [] },
    four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
    personality: { tone: '', pushback: '', format: '' },
    avatar: null, running: false, today_turns: 0,
    scheduled_count: 0, triggered_count: 0,
  },
  {
    id: 'ali', type: 'human', name: 'Ali', role: 'Operator',
    reports_to: 'joe', lob: 'agency', projects: [],
    skills: { primary: [] },
    owns: { scheduled_tasks: [], triggered_tasks: [], n8n_workflows: [], watchers: [] },
    four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
    personality: { tone: '', pushback: '', format: '' },
    avatar: null, running: null, today_turns: null,
    scheduled_count: 0, triggered_count: 0,
  },
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  // Skip auth — we mock it ourselves below.
});
const page = await context.newPage();

// Order matters: Playwright applies the LAST-registered matching
// route first, so register the catch-all FIRST and the specific
// stubs after, so specific stubs beat the catch-all.
await page.route(/\/api\//, async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await page.route(/\/api\/agents\/[^/]+\/avatar/, async (route) => {
  await route.fulfill({ status: 204, body: '' });
});
await page.route(/\/api\/org-chart-v2/, async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ nodes: NODES }),
  });
});


// Clear any persisted expansion before navigating.
await page.addInitScript(() => {
  try { window.localStorage.removeItem('claudeclaw.org-chart-v2.expansion'); } catch {}
});

// Capture page console errors so we can surface a clean 0-error
// promise alongside the screenshots.
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

await page.goto('http://localhost:5173/org-chart-v2?token=stub');
// Wait for the toolbar to render.
await page.getByTestId('org-chart-v2-toolbar').waitFor();
// Wait a tick more for the API stub + tree render.
await page.waitForTimeout(500);

// Default: roots open (joe).
await page.screenshot({ path: path.join(SHOTS, '01-default-1280.png'), fullPage: true });

// Expand all so the tree rails are visible.
await page.getByTestId('org-chart-v2-depth-all').click();
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(SHOTS, '02-depth-all-rails-1280.png'), fullPage: true });

// Click into a card with skills + lob to capture chip / lob render.
await page.screenshot({
  path: path.join(SHOTS, '03-meta-card-detail-1280.png'),
  clip: { x: 0, y: 80, width: 800, height: 700 },
});

// Mobile shot.
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, '04-mobile-375.png'), fullPage: true });

// Search shot.
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(200);
await page.getByTestId('org-chart-v2-search').fill('comms');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, '05-search-comms-1280.png'), fullPage: true });

await browser.close();
console.log('Screenshots written to', SHOTS);
console.log('Page console errors:', consoleErrors.length);
for (const e of consoleErrors) console.log('  -', e);
