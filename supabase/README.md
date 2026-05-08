# clawos ↔ Supabase bridges

This directory holds the **Supabase Edge Functions** that bridge data from your
goldbot Supabase project (`jzvgwxcckhwumdrtoebf`) into ClaudeClaw webhook
watchers. Each function is a **one-table-to-one-clawos-watcher bridge**: it
subscribes to a Supabase Database Webhook event, normalises the payload,
HMAC-signs the body, and POSTs to a clawos `/api/watchers/webhook/<slug>`
endpoint. The clawos watcher then queues a mission task (or whatever the
watcher's actions list says).

> **Why one function per table, not one shared function?** Each Supabase
> source table (`public.signals`, `analysis.signals_l1`, future
> `analysis.signals_l2`, etc.) has its own field shape, semantics, and
> downstream agent expectations. Funnelling them all through one function
> would couple the schemas and force every agent change to touch every
> source's branch. One bridge per source = one file to read, one file to
> deploy, one file to disable when a source goes off-line. This was
> deliberately chosen 2026-05-08 against the alternative single-function
> design.

---

## Current bridges

| Function | Source table | clawos watcher slug | Behaviour |
|---|---|---|---|
| [`clawos-ceddi-bridge`](./functions/clawos-ceddi-bridge/) | `public.signals` | `trading-monitor` | **Live broker pipeline.** Forwards INSERT + status-flip events. Default priority `medium`; agent may escalate to high. |
| [`clawos-ingest-bridge`](./functions/clawos-ingest-bridge/) | `analysis.signals_l1` | `trading-monitor-ingest` | **Observation-only.** Forwards every INSERT for ingest_only providers (GoldSignals.io, Gold Scalping & Zones, etc.). Default priority `low`, log only, no Telegram ping. |

---

## Pattern: adding a new bridge for a new Supabase table

Use this recipe when a new source table appears (e.g. `analysis.signals_l2`
for channel-stated outcomes, or `live.fills` for broker fills).

### 1. Spec the bridge

In one sentence, write down:

- **Source table:** `<schema>.<table>`
- **Trigger event(s):** `INSERT`, `UPDATE`, both?
- **clawos watcher slug:** new short slug, kebab-case (e.g. `tp-hits`, `fills-monitor`).
- **Downstream agent + behaviour:** which clawos agent gets the mission, and what should it actually do? Default action `queue-mission`, default priority depends on event criticality.

### 2. Generate the HMAC secret

```bash
openssl rand -hex 32
```

Add to clawos `.env` as `<UPCASE_SLUG>_SECRET=<hex>`. The clawos `watchers.ts`
loader auto-picks up env vars referenced by `secret_env` in `watchers.yaml`
(see `ensureWatcherEnvLoaded` in `src/watchers.ts`).

### 3. Add the watcher entry to `watchers.yaml`

```yaml
  - name: <Human-readable Name>
    type: webhook
    slug: <kebab-slug>          # → /api/watchers/webhook/<kebab-slug>
    secret_env: <UPCASE_SLUG>_SECRET
    mode: test                  # flip to `run` after smoke
    actions:
      - queue-mission:
          agent: <agent-id>
          title: "<short title with {payload.…}>"
          prompt: |
            <full instructions, reference {payload.…} fields the bridge sends>
```

The bot rereads `watchers.yaml` on every webhook request — **no restart
required** to add a new watcher. (Bot DOES need restart when you add a new
`secret_env` since env vars are loaded at boot — see `ensureWatcherEnvLoaded`
in `src/watchers.ts`.)

### 4. Create the function

Copy an existing bridge as a template:

```bash
cp -r supabase/functions/clawos-ingest-bridge supabase/functions/<new-function-name>
```

Edit the new `index.ts`:

- Update `CLAWOS_WEBHOOK_URL` default to point at the new slug.
- Update the `SECRET_ENV_NAME` constant to match step 2.
- Update the `mapRecord` function to map the new table's columns to the
  clawos payload shape.
- Update the JSDoc comment at the top with: source table, watcher slug,
  expected event types.

Update the bundled `README.md` for the new bridge — copy the structure of
`clawos-ingest-bridge/README.md` (deploy steps, test paths, failure modes).

### 5. Deploy + wire

```bash
supabase functions deploy <new-function-name>
supabase secrets set <UPCASE_SLUG>_SECRET=<hex-from-step-2>
```

Then in Supabase dashboard → Database → Webhooks:
- New webhook
- Table: `<schema>.<table>`
- Events: as specced
- Type: Supabase Edge Functions
- Function: `<new-function-name>`

### 6. Test

Curl the function URL with a synthetic body, then insert a real row in the
SQL editor. See each bridge's README for source-specific test recipes.

### 7. Document

Add a row to the **Current bridges** table at the top of this README so the
next agent knows the new bridge exists.

---

## Pattern: adding a new provider within an existing bridge

When goldbot adds a new provider that writes to an **existing** L1 table
(e.g. another swing channel posting into `analysis.signals_l1`), the bridge
function needs **zero code changes** if the provider follows the same row
shape. The flow:

1. Add the provider to `analysis.signals_l1.provider` CHECK constraint via
   a goldbot migration (see migration 066 for the pattern).
2. Add the new `signal_channels` row in goldbot Supabase with `kind='ingest_only'`
   and `is_enabled=true`.
3. Wait for new signals to arrive — the bridge will forward them.

If you need **per-provider behaviour** (e.g. "skip GoldSignals.io Swing on
Mondays"), add a small filter inside the bridge's `mapRecord` or `shouldForward`
function. Keep it data-driven where possible (Supabase row, env var, or
clawos config) so the bridge stays generic.

---

## Pattern: disabling a source temporarily

- **Channel level (preferred):** in goldbot Supabase, set
  `signal_channels.is_enabled = false`. Dispatcher stops writing rows for
  that channel; bridges naturally stop firing.
- **Bridge level:** in Supabase dashboard, disable the Database Webhook
  attached to that bridge. Stops ALL events for that table.
- **clawos level:** set `mode: test` on the watcher in `watchers.yaml`.
  Events still POST, get HMAC-verified, payload logged, but actions don't
  fire (mission not queued).

---

## Local development

```bash
supabase functions serve clawos-ingest-bridge
# then in another terminal:
curl -X POST http://localhost:54321/functions/v1/clawos-ingest-bridge \
  -H "Content-Type: application/json" \
  -d @path/to/test-event.json
```

## Project context

- ClaudeClaw repo: this repo. Bot config + watchers + dashboard live here.
- goldbot pipeline repo: `/Volumes/4TB-990/dev/files/`. Schema migrations,
  dispatcher, monitor.py.
- goldbot Supabase project ID: `jzvgwxcckhwumdrtoebf` (per
  `/Volumes/4TB-990/dev/files/.env`).
