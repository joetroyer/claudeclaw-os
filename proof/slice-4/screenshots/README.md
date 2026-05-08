# Slice 4 — Visual proof artifacts

Two screenshots are required for the QA gate:

- `n8n-mission-on-agent.png` — `/mission` page filtered by the owning agent (`research`) showing the auto-created mission task from a synthetic owned n8n error.
- `n8n-triage-on-meta.png` — `/mission` page filtered by `meta` showing the triage task from a synthetic unowned n8n error.

## How to capture

After running the synthetic owned/unowned errors documented in `proof/slice-4/n8n-router-e2e.md`:

```bash
DASHBOARD=https://clawos.joetroyer.com
TOKEN=<your DASHBOARD_TOKEN>
open "$DASHBOARD/mission?token=$TOKEN&agent=research"
# Take screenshot → save as proof/slice-4/screenshots/n8n-mission-on-agent.png

open "$DASHBOARD/mission?token=$TOKEN&agent=meta"
# Take screenshot → save as proof/slice-4/screenshots/n8n-triage-on-meta.png
```

Or via Playwright (headless):

```bash
npx playwright test proof/slice-4/playwright/slice-4.spec.ts \
  --reporter=line --workers=1
# Screenshots auto-saved on test failure; for success-path captures
# add `await page.screenshot({ path: '...png' })` to each spec.
```

## Status

PENDING (browser MCP tools not loaded by default in this worktree to keep the TypeScript surface tight, mirroring Slice 2's approach). The contract suite in `src/n8n-router.contract.test.ts` exercises the equivalent functional surface (19/19 tests pass) and the live curl-equivalent transcript at `proof/slice-4/n8n-router-e2e.md` exercises the routing in real code.

The Playwright spec is committed at `proof/slice-4/playwright/slice-4.spec.ts` for headless CI execution.
