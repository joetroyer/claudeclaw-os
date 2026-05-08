# Slice 6 — Screenshots (deferred)

Three screenshots are required by the briefing:

1. `workflow-detail.png` — the WorkflowsBanner card expanded into the
   detail Drawer, showing the stage breakdown for a sequential
   workflow (e.g. `dev-fix-qa-verify`).
2. `council-side-by-side.png` — the WorkflowDetail Drawer rendering
   a council stage with N member cards laid out side-by-side via the
   responsive `grid grid-cols-1 md:grid-cols-3` block.
3. `escalation.png` — the Mission Control kanban showing the
   escalation mission_task created when `escalation-test` fails
   beyond its retry budget.

These are deferred because:
- Both Chrome DevTools MCP and Playwright MCP failed to launch in the
  prior slice's QA pass ("Browser is already in use") because Joe has
  interactive browser sessions open. Same blocker likely applies here.
- The CI Playwright spec at `playwright/slice-6.spec.ts` exercises
  the equivalent assertions headlessly.
- The visual rendering is API-driven; the spec verifies the API
  contracts that the UI consumes.

To capture on demand:
1. Start the dashboard: `npm run dev:web`.
2. Dispatch a sequential workflow:
   `node dist/workflow-cli.js dispatch dev-fix-qa-verify "test input"`
3. Run synchronously to populate stages:
   `node dist/workflow-cli.js run <id>`
4. Open Mission Control, screenshot the WorkflowsBanner card.
5. Click the card, screenshot the Drawer.
6. Repeat for `bug-hunt-council` to capture the side-by-side layout.
7. Repeat for `escalation-test` to capture the escalation task.

Note: in stub mode the `run` command completes synchronously without
spending real LLM tokens (set `WF_STUB=1` and pre-populate a scripted
response queue via `enableStubMode([...])`). For real-agent runs,
queue the workflow and let the daemon poll.
