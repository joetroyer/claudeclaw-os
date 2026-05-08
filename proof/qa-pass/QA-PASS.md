# Wave 1 + Slice 4 — Live Browser QA Pass

**Performed:** 2026-05-08T01:11:00Z
**Tool:** Chrome DevTools MCP, navigated each new UI surface in the live dashboard at http://localhost:3141/.
**Bot fleet at time of QA:** 8/8 agents running clean (PIDs ~53600+, post the better-sqlite3 Node-20 prebuild restart and post-Slice-4 merge restart).

## Method

For each surface: navigate → wait for content → take full-page screenshot → list console messages filtered to error/warn level → assert empty. Console errors would have surfaced; none did across any surface.

## Results

| # | Surface | Slice | Screenshot | Console errors |
|---|---|---|---|---|
| 1 | `/mission` (Mission Control with new sidebar + Trading Monitor agent column) | 1, 2, 4, 6 | `01-mission-control.png` | none |
| 2 | `/agents/clawds/files` Persona tab (CLAUDE.md editor) | 1 | `02-slice1-agent-files-persona.png` | none |
| 3 | `/agents/clawds/files` Config tab (agent.yaml with Slice 1 keys: four_rs / owns / lob / projects / ideal / platform / skills / avatar) | 1 | `03-slice1-agent-files-config.png` | none |
| 4 | `/triggered` page listing both webhook watchers (`trading-monitor-trigger`, `n8n-error-router`) with copy-URL + status pills | 2 | `04-slice2-triggered.png` | none |
| 5 | `/org-chart` Hierarchy tab — 4 LOB cards (Agency, Gold Bot, Course, Personal) + Unassigned bucket gracefully holding 8 agents | 3 | `05-slice3-orgchart-hierarchy.png` | none |
| 6 | Drilled into Unassigned bucket — all 8 agents render with descriptions including new Trading Monitor | 3 | `06-slice3-orgchart-unassigned-bucket.png` | none |
| 7 | Analytics tab — workload counts surface | 3 | `07-slice3-orgchart-analytics.png` | none |
| 8 | `/scorecard` By-agent tab — real cost data (Main 43 turns / 57.4k tok / $0.85; Gold Bot Labs / Research / Meta / Clawds / Comms / Content / Ops / Trading Monitor) | 5 | `08-slice5-scorecard.png` | none |
| 9 | `/budget` route lands on By-LOB-/-project tab directly (Slice 5 fix) — clickable LOB chips even with 2 groups | 5 | `09-slice5-budget.png` | none |
| 10 | `/agents` listing — 9 total agents, 8 live, 1 offline (Trading Monitor with `Start` button) | 1, 2, 7 | `10-slice2-7-agents-listing.png` | none |
| 11 | `/agents/trading-monitor/files` — generated persona renders cleanly (Slice 2's persona-generator-output proof) | 2, 7 | `11-slice2-trading-monitor-persona.png` | none |

## Cross-cutting checks

- **Status indicator** "● ClaudeClaw All systems normal" rendered consistently on every page in the sidebar footer.
- **Sidebar** correctly shows all new routes added by Wave 1 + Slice 4 (Triggered, Org Chart, Scorecard).
- **Console** zero errors and zero warnings across 11 navigations.
- **Bot fleet** unchanged across the QA pass: 8 running with launchctl exit 0.

## Live n8n end-to-end (separate from browser QA)

- 3 synthetic POSTs to `/api/watchers/webhook/n8n-error` with valid HMAC.
- All 3 created mission_tasks on `meta` agent (visible at `/mission`).
- Test #3 (after the Slack adapter fix) successfully fired the Jarvis Slack Messenger n8n workflow → Slack post in #integration-alerts. Confirmed via n8n executions API (`workflowId=CHdeF2Snf3QTeNy9`, status=success, startedAt=2026-05-08T00:59:57Z).

## Verdict

**PASS.** All 6 merged slices' UI surfaces render cleanly with real data, no console errors, no broken layouts. Slice 4's n8n routing + Slack adapter verified end-to-end. Bot fleet healthy throughout.

## Open follow-ups (non-blocking, surfaced earlier)

1. Set `TRADING_MONITOR_SECRET` in `.env` if/when you wire the trading monitor to the n8n trading-signal webhook (currently shows "secret missing" pill).
2. Bootstrap trading-monitor's launchd plist (`launchctl bootstrap`) to take it from offline → live in the agents listing.
3. Flip `n8n-error-router` watcher mode `test` → `run` after a couple of real n8n errors verify the routing.
4. `startWatchers()` is exported but never called from the bot boot path — log-tail/sqlite-poll watchers are not currently running. Webhook watchers work because they're HTTP-driven via `loadWebhookWatcher(slug)` per request.
