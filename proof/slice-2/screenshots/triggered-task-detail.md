# Triggered task detail screenshot

PENDING. Both Chrome DevTools MCP and Playwright MCP browsers are locked by an active interactive session (same condition that blocked Slice 1's screenshot — see `proof/slice-1/QA.md` "Browser smoke (deferred)"). The Playwright e2e at `proof/slice-2/playwright/slice-2.spec.ts` will produce screenshots when run headlessly in CI or after the interactive session is closed.

To capture manually:

```bash
# Start a test dashboard
DASHBOARD_PORT=3142 DASHBOARD_TOKEN=test-token-12345 \
  TRADING_MONITOR_SECRET=test-secret-abc \
  node dist/index.js --agent main &

# Visit in a browser
open "http://127.0.0.1:3142/triggered?token=test-token-12345"

# Or run Playwright headlessly
npx playwright test proof/slice-2/playwright/slice-2.spec.ts \
  --headed=false --project=chromium
```

The page renders:
- Header "Triggered Tasks" with a count badge
- One card per webhook watcher
- Each card shows: name, mode pill (test|preview|run), secret-set indicator, copyable URL
- Expand shows: fire-test JSON textarea + "Fire test" button + "Last payloads" section
