# Slice 2 — Trading Monitor end-to-end smoke

This is a worked transcript of a trading signal flowing in via webhook and surfacing as a `mission_task` for the new `trading-monitor` agent.

## Setup

- Dashboard process running with `TRADING_MONITOR_SECRET=test-secret-abc`
- watchers.yaml entry `trading-monitor-trigger` with `mode: test` and `slug: trading-monitor`
- `agents/trading-monitor/` exists with `agent.yaml` + `CLAUDE.md`
- `launchd/com.claudeclaw.trading-monitor.plist` exists (NOT yet bootstrapped — that's a deploy step)

## 1. POST a signal payload (signed)

```bash
TOKEN=test-token-12345
BASE=http://127.0.0.1:3142
BODY='{"signal":"buy","instrument":"XAUUSD","entry":2350}'
SIG=$(node -e "const c=require('crypto'); console.log(c.createHmac('sha256','test-secret-abc').update('$BODY').digest('hex'))")

curl -s -o /tmp/r3.json -w "status=%{http_code}\n" \
  -X POST "$BASE/api/watchers/webhook/trading-monitor" \
  -H "content-type: application/json" \
  -H "x-claudeclaw-signature: sha256=$SIG" \
  -d "$BODY"
```

Result:

```
status=200
{"ok":true,"mode":"test","payload_id":3,"queued_mission_tasks":["wat_mow3od0t_hxy5ck"]}
```

## 2. Confirm the mission_task was queued for the trading-monitor agent

```bash
sqlite3 store/claudeclaw.db \
  "SELECT id, title, assigned_agent, status, created_by FROM mission_tasks \
   WHERE id='wat_mow3od0t_hxy5ck'"
```

Result:

```
wat_mow3od0t_hxy5ck|Trading signal received (trading-monitor)|trading-monitor|queued|watcher
```

## 3. Confirm the payload was persisted with signature_valid=1

```bash
sqlite3 store/claudeclaw.db \
  "SELECT id, watcher_slug, signature_valid, mode, remote_ip FROM webhook_payloads \
   WHERE id=3"
```

Result:

```
3|trading-monitor|1|test|unknown
```

## 4. Confirm rejected requests are also logged

Earlier in the smoke we POSTed an unsigned body and a wrong-signature body. Both 401'd. Both still logged:

```bash
sqlite3 store/claudeclaw.db \
  "SELECT id, signature_valid, mode FROM webhook_payloads ORDER BY id DESC LIMIT 5"
```

Result:

```
3|1|test     # accepted
2|0|test     # rejected (wrong sig)
1|0|test     # rejected (no sig)
```

## 5. Agent activation (deploy step, not yet executed)

For the trading-monitor agent to actually consume its mission_tasks, the operator runs:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT"

# Stamp the plist template with absolute paths
NODE_PATH=$(which node)
HOME_DIR="$HOME"
CLAUDE_CONFIG_DIR="$HOME/.claude"
sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__PROJECT_DIR__|$PROJECT_ROOT|g" \
    -e "s|__HOME__|$HOME_DIR|g" \
    -e "s|__CLAUDE_CONFIG_DIR__|$CLAUDE_CONFIG_DIR|g" \
    launchd/com.claudeclaw.trading-monitor.plist \
    > ~/Library/LaunchAgents/com.claudeclaw.trading-monitor.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeclaw.trading-monitor.plist
```

That step is intentionally NOT automated. The CLAUDE.md persona prose was written by the implementer for Joe's review and approval before any production process runs against it.

## What the trading-monitor agent will do when it picks up the task

When `dist/index.js --agent trading-monitor` runs and the mission worker pulls task `wat_mow3od0t_hxy5ck`, it will:

1. Read the prompt (which contains the raw payload and instructions to parse + classify + log).
2. Apply the persona at `agents/trading-monitor/CLAUDE.md`: parse provider, side, instrument, entry, SL, TP; classify priority; log to hive_mind; notify Joe if priority=high.
3. Reply with a tight bullet list summarizing the parsed signal.

Crucially: the persona explicitly forbids placing orders. The agent is read-only on the lab and the broker. It is the structured equivalent of the previous terminal-based monitor — no behavior change in what reaches Joe; the change is the substrate (queue + worker + persona) replacing an ad-hoc terminal loop.

## What changes in production

| Before                                       | After (this slice)                                     |
|----------------------------------------------|--------------------------------------------------------|
| Terminal loop tails a log, parses signals    | External listener POSTs to `/api/watchers/webhook/...` |
| Notifications flow through ad-hoc print/grep | Notifications flow through `mission_tasks` + Telegram  |
| No audit trail                               | Every payload persisted in `webhook_payloads`          |
| No HMAC                                      | HMAC-SHA256 enforced on `run`/`test`                   |
| No preview / test                            | Three modes: test, preview, run                        |

## Open follow-up

- The trading-monitor agent's launchd plist is created but not bootstrapped. Operator should review `agents/trading-monitor/CLAUDE.md` (the persona) before going live. The persona is intentionally conservative: no order placement, no broker integration, only parse + log + notify.
