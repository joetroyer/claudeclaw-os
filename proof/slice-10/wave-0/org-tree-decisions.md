# Slice 10 Wave 0 — Org tree decisions

This doc records the `reports_to` edges chosen by the migration script
plus the rationale, so Joe (or the Wave 1 UI implementer) can change
them with eyes open. Every edge is two YAML keystrokes away — they are
not load-bearing in any code path other than the OrgChartV2 page.

## The tree

```
joe (Human · Founder & Operator)
├── meta (AI · Chief of Staff)               reports_to: joe
│   ├── content (AI · Director of Content)   reports_to: meta
│   ├── research (AI · Director of Research) reports_to: meta
│   ├── ops (AI · Director of Operations)    reports_to: meta
│   ├── comms (AI · Director of Comms)       reports_to: meta
│   └── clawds (AI · Google Ads Specialist)  reports_to: meta
├── trading-monitor (AI · Trading Desk Lead) reports_to: joe
└── goldbot-labs (AI · Lab Researcher)       reports_to: joe

ali (Human · Operator)                       reports_to: joe
```

## Rationale per edge

### `meta → joe`

The Obsidian note (`LinkedIn — I Have 150 AI Employees (Org Chart Tour).md`)
calls out that AI nodes can occupy ANY tier — heads, directors, ICs.
Meta is already the team's Chief of Staff in `agents/meta/CLAUDE.md`
("Coordinator. Splits work across the team, routes follow-ups, owns
multi-agent orchestration"). Slotting Meta directly under Joe gives the
"AI-as-head" spec exactly what it asks for: a single AI dispatcher
between the human founder and the rest of the team.

### `comms → meta`, `content → meta`, `research → meta`, `ops → meta`

These four agents are Slice-1 specialists. Meta currently routes work
to them via `delegate_to_agent` (see `agents/meta/CLAUDE.md`). Making
the delegation tree match the org chart keeps the runtime model and the
visual model aligned — no surprise edges where Meta delegates downward
but the chart shows a sibling relationship.

### `clawds → meta` (the flagged decision)

The spec called out clawds as the controversial pick: "reports_to: joe
(or meta — your call, document it)". I chose `meta` for two reasons:

1. **LOB alignment.** clawds is in the agency LOB and produces
   client-facing deliverables. The four other directors under meta are
   either personal or course LOB. Agency client work IS the kind of
   thing a Chief of Staff coordinates — keeping it under meta means the
   meta agent has full visibility on every billable surface.
2. **Future routing.** When Joe wires clawds into the meta delegation
   list (currently `agents/meta/CLAUDE.md` mentions clawds as
   "**clawds** — Google Ads (when added)"), the org chart and the
   delegation tree stay in sync.

If Joe wants clawds reporting directly to him (e.g. because the agency
LOB is solo work he doesn't delegate), edit `agents/clawds/agent.yaml`
and change `reports_to: "meta"` to `reports_to: "joe"`. No code change
required — the org-chart-v2 reader picks it up on the next request.

### `trading-monitor → joe` and `goldbot-labs → joe`

Trading-desk and lab agents are Joe-owned operations: they touch
trading signals and lab analysis directly, not via meta. The Slice 2
trading-monitor agent was specifically built to acknowledge a
webhook within 60s without meta in the loop. Putting it under meta
would imply a routing layer that doesn't exist. Same for goldbot-labs:
Joe asks it for backtest leaderboards directly.

### `ali → joe`

Per Slice 3's seed, Ali is an Operator on the agency LOB. Joe is the
founder — single human-to-human edge.

## What's not encoded here

`reports_to` is a single-parent edge. The Obsidian note also mentions
matrixed responsibilities (e.g. an AI specialist contributing to
multiple LOBs). That's an extension for a later wave — Wave 0 sticks
with the simple tree. The `lobs` field on each agent already captures
the secondary-affiliation surface area for any UI that wants to render
matrixed edges later.

## Files affected

- `agents/_template/agent.yaml.example` — `reports_to: "joe"` (safe
  default for new agents). Worker-template inherits this on first copy.
- `agents/<id>/agent.yaml.example` — per-agent edge per the table above.
- `humans.yaml` — `joe.reports_to: ""` (root); `ali.reports_to: "joe"`.

The migration script `scripts/migrate-org-v2.ts` is the source of
truth for the default edges; if you change the table here, update the
`REPORTS_TO_BY_AGENT_ID` map in the script as well.
