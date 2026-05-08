// Slice 10 Wave 4 — visual check for the OrgChartV2 horizontal layout.
// Mocks /api/org-chart-v2 with the full ClaudeClaw roster (joe + 7
// humans + 9 AI agents inc. synthesized main + meta sub-tree). Drives
// the Vite dev server at :5173, captures screenshots at 1280×900 and
// 375×812.
//
// Usage:
//   cd web && npm run dev   # in one terminal
//   node proof/slice-10/wave-4/visual-check.mjs
//
// Requires `playwright` (already a dev dep).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

// Full ClaudeClaw roster — 18 nodes total.
function node(o) {
  return {
    id: o.id,
    type: o.type,
    name: o.name,
    role: o.role ?? '',
    reports_to: o.reports_to ?? null,
    lob: o.lob ?? null,
    projects: o.projects ?? [],
    skills: { primary: o.skills ?? [] },
    owns: {
      scheduled_tasks: o.scheduled ?? [],
      triggered_tasks: o.triggered ?? [],
      n8n_workflows: [],
      watchers: [],
    },
    four_rs: {
      role: '',
      responsibilities: o.responsibilities ?? [],
      results: [],
      requirements: [],
    },
    personality: { tone: '', pushback: '', format: '' },
    avatar: o.avatar ?? null,
    running: o.running ?? null,
    today_turns: o.today_turns ?? null,
    scheduled_count: (o.scheduled ?? []).length,
    triggered_count: (o.triggered ?? []).length,
  };
}

const NODES = [
  // ── humans ────────────────────────────────────────────────────────
  node({ id: 'joe', type: 'human', name: 'Joe', role: 'Founder & operator',
    reports_to: null, avatar: '/avatars/joe.jpg',
    responsibilities: ['Set strategy across agency, course, gold bot, personal'] }),
  node({ id: 'ali', type: 'human', name: 'Ali', role: 'Operator',
    reports_to: 'joe', lob: 'agency',
    responsibilities: ['Run delivery for the 7-person agency team'] }),
  node({ id: 'ali-abbas', type: 'human', name: 'Ali Abbas', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  node({ id: 'awab', type: 'human', name: 'Awab', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  node({ id: 'eduardo-trinidad', type: 'human', name: 'Eduardo', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  node({ id: 'july-sanchez', type: 'human', name: 'July', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  node({ id: 'muhammad-tauseef', type: 'human', name: 'Tauseef', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  node({ id: 'nouman-khalil', type: 'human', name: 'Nouman', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  node({ id: 'ryan-claudio', type: 'human', name: 'Ryan', role: 'Agency team',
    reports_to: 'ali', lob: 'agency' }),
  // ── AI agents ─────────────────────────────────────────────────────
  node({ id: 'main', type: 'ai', name: 'Main',
    role: 'Primary ClaudeClaw assistant (@ClawdOS1_bot)',
    reports_to: 'joe', running: true, today_turns: 27,
    skills: ['gws', 'todo', 'maestro'],
    responsibilities: ['Triage messages, dispatch to specialists, run skills on demand'] }),
  node({ id: 'meta', type: 'ai', name: 'Meta',
    role: 'Coordinator. Splits work, owns multi-agent orchestration.',
    reports_to: 'joe', lob: 'personal',
    skills: ['planning', 'roadmap', 'okrs'],
    scheduled: ['daily-rollup', 'weekly-summary'],
    running: true, today_turns: 4,
    responsibilities: ['Orchestrate the 5 specialist agents under it'] }),
  node({ id: 'comms', type: 'ai', name: 'Comms',
    role: 'Email, Slack, WhatsApp, YouTube, LinkedIn DMs.',
    reports_to: 'meta', lob: 'agency',
    skills: ['gmail', 'slack', 'whatsapp'],
    scheduled: ['daily-digest'],
    running: true, today_turns: 12,
    responsibilities: ['Inbox triage and reply drafting across all channels'] }),
  node({ id: 'content', type: 'ai', name: 'Content',
    role: 'Long-form writing — blog posts, scripts, captions.',
    reports_to: 'meta', lob: 'agency',
    skills: ['copywriting', 'seo'],
    responsibilities: ['Draft blog + LinkedIn content in brand voice'] }),
  node({ id: 'research', type: 'ai', name: 'Research',
    role: 'Web research, academic sources, competitive intel.',
    reports_to: 'meta', lob: 'agency',
    skills: ['web-research', 'gws'],
    responsibilities: ['Deep-profile prospects + run competitor sweeps'] }),
  node({ id: 'ops', type: 'ai', name: 'Ops',
    role: 'SOPs, n8n workflows, scheduled task ownership.',
    reports_to: 'meta', lob: 'personal',
    skills: ['n8n', 'cron'],
    scheduled: ['weekly-cleanup'],
    responsibilities: ['Build and maintain automation workflows'] }),
  node({ id: 'clawds', type: 'ai', name: 'Clawds',
    role: 'Code review and pair-programming.',
    reports_to: 'meta', lob: 'personal',
    skills: ['code-review'],
    responsibilities: ['Review PRs and pair on tricky bugs'] }),
  node({ id: 'goldbot-labs', type: 'ai', name: 'Gold Bot Labs',
    role: 'Backtest scenario generation and tuning.',
    reports_to: 'joe', lob: 'goldbot',
    skills: ['backtesting', 'lab-cli'],
    responsibilities: ['Run lab scenarios and surface drawdown profiles'] }),
  node({ id: 'trading-monitor', type: 'ai', name: 'Trading Monitor',
    role: 'Live trade alerting + risk surveillance.',
    reports_to: 'joe', lob: 'goldbot',
    skills: ['ws-feeds', 'alerts'],
    triggered: ['drawdown-breach'],
    responsibilities: ['Watch live trades and ping on R-multiple anomalies'] }),
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

await page.route(/\/api\//, async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
await page.route(/\/api\/agents\/[^/]+\/avatar/, async (route) => {
  await route.fulfill({ status: 204, body: '' });
});
await page.route(/\/avatars\/[^/]+\.jpg/, async (route) => {
  await route.fulfill({ status: 204, body: '' });
});
await page.route(/\/api\/org-chart-v2/, async (route) => {
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ nodes: NODES }),
  });
});

await page.addInitScript(() => {
  try { window.localStorage.removeItem('claudeclaw.org-chart-v2.expansion'); } catch {}
});

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

await page.goto('http://localhost:5173/org-chart-v2?token=stub');
await page.getByTestId('org-chart-v2-toolbar').waitFor();
await page.waitForTimeout(600);

// 01: default depth-3 view at 1280×900 — the headline shot.
await page.screenshot({
  path: path.join(SHOTS, '01-default-depth-3-1280x900.png'),
  fullPage: false,
});

// 02: full-page so the entire tree is captured even if it scrolls.
await page.screenshot({
  path: path.join(SHOTS, '02-default-full-page-1280.png'),
  fullPage: true,
});

// 03: expand-all view — same wide-row layout, every leaf visible.
await page.getByTestId('org-chart-v2-depth-all').click();
await page.waitForTimeout(300);
await page.screenshot({
  path: path.join(SHOTS, '03-depth-all-1280.png'),
  fullPage: true,
});

// 04: card detail (Meta with skills + LOB pill + Four-Rs preview)
const metaCard = page.getByTestId('org-chart-v2-card-meta');
await metaCard.waitFor();
const box = await metaCard.boundingBox();
if (box) {
  await page.screenshot({
    path: path.join(SHOTS, '04-card-detail-meta.png'),
    clip: {
      x: Math.max(0, Math.round(box.x) - 8),
      y: Math.max(0, Math.round(box.y) - 8),
      width: Math.min(1280, Math.round(box.width) + 16),
      height: Math.round(box.height) + 16,
    },
  });
}

// 05: focus mode on meta — only the meta subtree visible.
await page.goto('http://localhost:5173/org-chart-v2?token=stub');
await page.getByTestId('org-chart-v2-toolbar').waitFor();
await page.waitForTimeout(400);
await page.getByTestId('org-chart-v2-title-meta').click();
await page.waitForTimeout(400);
await page.screenshot({
  path: path.join(SHOTS, '05-focus-mode-meta.png'),
  fullPage: false,
});

// 06: mobile (375×812) — cards still readable; tree may stack.
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(300);
await page.screenshot({
  path: path.join(SHOTS, '06-mobile-375x812.png'),
  fullPage: true,
});

// Count the visible cards on default depth 3 view at 1280×900 to feed
// into the proof report.
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('http://localhost:5173/org-chart-v2?token=stub');
await page.getByTestId('org-chart-v2-toolbar').waitFor();
await page.waitForTimeout(500);
const visibleCount = await page.locator('[data-testid^="org-chart-v2-card-"]:visible').count();
const cardWidthMeasure = await metaCard.boundingBox();

await browser.close();
console.log('Screenshots written to', SHOTS);
console.log('Console errors:', consoleErrors.length);
for (const e of consoleErrors) console.log('  -', e);
console.log('Visible cards at default depth-3 / 1280×900:', visibleCount);
console.log('Card width (meta):', cardWidthMeasure?.width);
