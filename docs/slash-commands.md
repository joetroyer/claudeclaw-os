# Slash commands & skill discovery

The dashboard surfaces every registered skill (project + global) as a
slash command in two places:

- `/warroom/text` — the legacy server-rendered war-room text page.
- `/chat` — the SPA chat (React/Preact at `web/src/pages/Chat.tsx`).

Both surfaces use the same affordance:

1. A `/Commands` button next to the send button.
2. Typing `/` at the start of the composer.

Either gesture opens a popover with a search input pinned at the top
and the full skill list below. Filtering is token-aware: every
whitespace-separated token must appear in the command id, name, or
description.

## Where the catalog comes from

`GET /api/skills` returns:

```json
{
  "skills": [
    { "id": "gmail", "name": "Gmail", "description": "...", "source": "project" },
    ...
  ]
}
```

Source is either `project` (lives in `<repo>/skills/`) or `global`
(lives in `~/.claude/skills/`). Project skills win when both define the
same id. The endpoint is gated by the standard dashboard token.

## Live reload

The registry installs a recursive `fs.watch` on both skill roots when
`initSkillRegistry()` runs at boot (`src/index.ts`). Any add / remove /
edit triggers a 500ms-debounced rescan; the in-memory map is swapped
atomically so `/api/skills` readers never see a half-built state.

Frontend behavior:

- War Room text fetches once on page load and updates its
  `Commands · N` label.
- The SPA SkillPicker caches the catalog at module scope and refetches
  on `visibilitychange` + `focus` so swapping back to the tab picks up
  newly added skills.

There is intentionally no WebSocket / SSE push for skill updates. The
surface is rare, the payload is small, and the focus-driven refresh
covers the only realistic case (you added a skill in your editor and
came back to the dashboard).

## Inserting into the composer

Picking a command sets the composer to `/<id> ` and drops the caret at
the end. The user fills in the args and hits Enter to send. The
orchestrator sends the message normally; Claude (the model) handles
the `/<skill>` invocation server-side.

For the war-room text page this is identical to the previous behavior
— only the entry UX changed. For `/chat` this is new; previously
there was no command discovery at all.
