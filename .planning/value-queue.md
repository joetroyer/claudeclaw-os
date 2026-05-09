# ClawOS Value Queue — Scoping

5 high-leverage items to populate the system with proven scheduled/triggered tasks. Each has research notes + open questions + suggested next move.

---

## 1 · Post-meeting recap → Slack comment with @-tags

**Status:** Skill scaffolded at `~/.claude/skills/meeting-recap/SKILL.md` (universal, NOT GLTH-specific).

**What it does:** Recording lands → fetch transcript (Zoom .vtt > Groq fallback) → find Google Doc → extract action items → post Slack comment with @-tagged owners (threaded under the original "Recording Completed" message when possible). Quality gate: never fabricate items not grounded in transcript/doc.

**Wires into:**
- n8n `oWmSJf851EFlDPJn "Zoom Recording > Slack"` already TEEs to clawos on `recording.transcript_completed`
- Watcher `glth-zoom-recording` in `watchers.yaml` (currently GLTH-only — generalize to any meeting via topic match in n8n)

**What's left:**
- Run skill-creator audit on `meeting-recap/SKILL.md` against the May 8 GLTH transcript (already at `/tmp/glth/audio.vtt`)
- Generalize n8n trigger so any meeting (not just "GLTH Sales & Marketing") fires the webhook → watcher routes by topic → meeting-recap skill handles transcript + Slack post

**Owner:** ops agent (already wired)

---

## 2 · Gmail Inbox 0 skill (port from jarvis)

**Status:** Source exists at `4tb/dev/jarvis` (per Joe). Needs porting to `~/.claude/skills/gmail-inbox-0/`.

**What it does:** Daily scheduled scan of inbox → triage each unread (reply / archive / snooze / ignore) → draft replies for "needs-reply" → present to Joe for approval → batch-send approved drafts. Quality gate: never auto-send without confirmation in chat.

**Research needed:**
- [ ] Locate jarvis copy: `/Volumes/4TB-990/dev/jarvis` doesn't exist on disk per earlier grep — Joe may need to point me at the right path. Could be in iCloud / older backup.
- [ ] Understand current triage logic (rules-based? LLM-classified?)
- [ ] Confirm `gws gmail` has the right scopes (gmail.modify is granted post-reauth ✓)

**Wires into:**
- `comms` agent (per agent.yaml) owns email
- Existing `~/.claude/skills/gmail/` skill (basic Gmail commands) — would extend, not duplicate
- ClickUp list ID for "needs-reply followup" tasks?

**Suggested next move:** Joe surfaces the jarvis path; I read it and write a port plan before touching anything.

**Owner:** comms agent

---

## 3 · Website Load Time auto-optimization

**Status:** Daily n8n alert exists; nothing on the optimization side.

**What we have:**
- n8n workflow `RGgLfI0RUdDkYfzq "Website Load Time Monitor"` — checks a list of sites daily, posts to Slack #integration-alerts via Jarvis Slack Messenger when load > 2s
- Slack message format: `:warning: Website Load Time Alerts :warning:\n@<owner>\nSite: <name>\nURL: <url>\nLoad Time: <time> seconds`
- Cloudflare API token + account ID in `.env` (memory: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
- Sites are on Cloudflare DNS, use Perfmatters, built with Elementor or Bricks

**What it does (target):** Slack alert lands → ops agent picks up → diagnostic phase (CF cache hit %, Perfmatters config, recent plugin/theme updates, large unoptimized images) → optimization phase (purge cache, tune Perfmatters, defer non-critical CSS/JS) → re-test → if better post "fixed" comment in same Slack thread; if regressed, ROLL BACK and post diagnostic with recommended manual changes.

**Critical safety guard:** caching / CSS deferral / JS delay can break sites. Required:
- Pre-test screenshot via Playwright on key pages (homepage, one product/post page, checkout)
- Apply ONE optimization at a time
- Post-test screenshot — visual diff must show "no broken layout"
- If diff fails: revert + escalate

**Open research:**
- [ ] Get the list of monitored sites from n8n (the workflow or a Google Sheet)
- [ ] Check `~/.claude/skills/seomaven/` and `~/.claude/skills/glth/` — they might already have site-specific knowledge
- [ ] Understand Perfmatters API access (does Perfmatters expose REST? or do we need WP admin via wp-cli over SSH?)
- [ ] Bricks vs Elementor — different flush patterns

**Wires into:**
- New watcher in `watchers.yaml`: slug `slow-site-alert`, type webhook, agent ops
- Add a TEE to the existing n8n workflow that POSTs to clawos with site URL + load time
- Builds skill `~/.claude/skills/site-perf-fix/`

**Suggested next move:** Inspect n8n workflow `RGgLfI0RUdDkYfzq` to extract the site list + alert format; pull the existing `seomaven` skill to see what's already there.

**Owner:** ops agent

---

## 4 · Freshdesk daily review (replace July's manual loop)

**Status:** Production n8n workflow already running. July currently manually reviews each AI-drafted response.

**What we have:**
- Active n8n workflow: `ydOAkMcBV5OvYauU "Updated - Freshdesk AI Agent"`
  - Schedule trigger → fetch new tickets → Tier 1 / Tier 2 / Tier 3 classifier agents (OpenRouter) → routing switch → drafted response → POST response → close ticket → log to Sheets
  - Has 3 OpenRouter chat models (different tiers)
  - Calls another workflow `'V3 Tagger & Report - Manual copy'` for tagging
  - Has `Truncate description (45k limit)` node — single-ticket context already pre-trimmed
- Active n8n workflow: `MY8XutCAPBuRHJ7v "V4 FD Ticket Tagger"` — runs alongside, tags incoming
- Two Google Sheets:
  - `1nFVZ3LzLvDxGgRW8Hot9PkG5ZyLoBspjwFYQy6gIZNU`
  - `1swb1sLJv8rdYSvOPauQP9Yu7fWKQC3XdhZxF8kM95Hs`
  - One is the daily activity log (which?); the other might be the rules / category map.

**What it does (target):** Daily 9am scheduled task → Gemini agent (1M context) → reads BOTH sheets entirely + reads the day's posted responses + reads the corresponding Freshdesk threads → grades each AI response (correct? tone? policy-compliant? should have escalated?) → flags edge cases for July to review → publishes a daily report (Slack #integration-alerts thread + a `freshdesk-daily-audit` ClickUp task with summary).

**Why Gemini:** the volume (multiple sheets + N tickets/day + thread bodies) is the use case Gemini's 2M context was built for. Claude would need RAG; Gemini just reads it all.

**Open research:**
- [ ] Identify which sheet is "log" vs "rules"
- [ ] Daily ticket volume (tells us if this fits in 2M tokens)
- [ ] What does July's current review surface? Need her acceptance/rejection criteria as the rubric for the agent
- [ ] Where's the V4 Ticket Tagger output? Same sheets?

**Wires into:**
- New scheduled task: cron `0 14 * * *` (9am ET), agent ops, runs the gemini-review skill
- New skill `~/.claude/skills/freshdesk-daily-audit/`
- May need a new watcher if we want July's manual approvals to also feed the rubric

**Suggested next move:** Joe spends 5 min walking through July's review process so I capture the rubric. Without that, the Gemini agent has no quality bar.

**Owner:** ops agent (with `gemini-api-dev` skill for the LLM call)

---

## 5 · Chat-with-agent icons (PARTIAL — 3 of 5 surfaces shipped)

**Status:** Merged to main (`f004389`). Mission Control, Scheduled, Agents page DONE. Triggered + Org Chart V2 SKIPPED — the agent claimed the files don't exist; they actually do. Quick follow-up needed.

**Files that need the icon added:**
- `web/src/pages/Triggered.tsx` — agent column on each watcher row (parallel to the Scheduled implementation)
- `web/src/pages/OrgChartV2.tsx` — `⋯` menu on AI nodes only

**Suggested next move:** 10-min follow-up agent or me directly. Trivial — uses the existing `web/src/components/ChatWithAgentButton.tsx` component.

---

## Cross-cutting follow-ups (not items, but blockers if ignored)

**A · Skill iteration loop with skill-creator** — install confirmed at `~/.claude-trading/plugins/`. Run audit cycles on the meeting-recap skill against the GLTH transcript already at `/tmp/glth/audio.vtt`. This is the pattern for proving each new skill before it gets a watcher.

**B · `silent_start` / `silent_result` flag wiring** — when a watcher queues a mission task, ops bot AND main bot both ping Joe. Set `silent_start=true, silent_result=false` for ops-owned mission tasks so only one channel speaks.

**C · Agent failure-message standard** — Clawd's "Blocked on transcript + Doc — run `gws auth login -s drive,docs` to unblock" reply is the pattern Joe wants every agent to use on failure. Add to each agent's CLAUDE.md as a hard rule.

---

## Order of operations (my read)

1. **Now:** Skill-creator audit cycle on `meeting-recap` against the GLTH transcript. Validates the loop end-to-end before adding more skills.
2. **Next:** Item #5 follow-up (Triggered + OrgChartV2 icons) — 10 min throwaway.
3. **Then:** Item #3 (Website Load Time autoperf) — highest leverage, repeated daily, real user pain.
4. **Then:** Item #4 (Freshdesk audit) — biggest scope, needs Joe's rubric session first.
5. **Last:** Item #2 (Gmail Inbox 0) — needs jarvis source; defer until Joe surfaces it.
6. **Cross-cutting B + C** during whichever item next surfaces the bot-noise problem.
