---
name: google-calendar
description: Manage Google Calendar via the `gws` CLI. Create events with Meet links, send invites, check availability.
allowed-tools: Bash(gws *), Bash(git rev-parse *), Bash(jq *), Bash(python3 *)
---

# Google Calendar Skill

## Purpose

Create meetings with Google Meet links, send invites, check availability, and manage events for joetroyer@gmail.com via the Google Workspace CLI (`gws`).

## Backend

Uses `gws` (`@googleworkspace/cli`), already installed and authed at `~/.config/gws/`. Calendar API output is structured JSON — pipe through `jq`.

If you see `403 insufficient authentication scopes`, the calendar scope isn't on the token. Run:

    gws auth login -s gmail,calendar,drive,sheets,docs
    rm ~/.config/gws/token_cache.json

Then retry.

## Commands

### List upcoming events (next 10)

    NOW=$(python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).isoformat().replace('+00:00','Z'))")
    gws calendar events list --params "$(jq -nc --arg t "$NOW" '{calendarId:"primary",timeMin:$t,maxResults:10,singleEvents:true,orderBy:"startTime"}')"

### List events within N days

    NOW=$(python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).isoformat().replace('+00:00','Z'))")
    END=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(days=7)).isoformat().replace('+00:00','Z'))")
    gws calendar events list --params "$(jq -nc --arg s "$NOW" --arg e "$END" '{calendarId:"primary",timeMin:$s,timeMax:$e,singleEvents:true,orderBy:"startTime",maxResults:50}')"

### Get event details

    gws calendar events get --params '{"calendarId":"primary","eventId":"<eventId>"}'

### Create event with Meet link and invites

    TITLE="Meeting Title"
    START="2026-03-15T10:00:00"      # local time, no Z
    END="2026-03-15T10:30:00"
    TZ="America/New_York"
    ATTENDEES='[{"email":"person@example.com"},{"email":"other@example.com"}]'
    gws calendar events insert --params '{"calendarId":"primary","conferenceDataVersion":1,"sendUpdates":"all"}' \
      --json "$(jq -nc \
        --arg t "$TITLE" --arg s "$START" --arg e "$END" --arg tz "$TZ" \
        --argjson att "$ATTENDEES" \
        '{summary:$t,
          start:{dateTime:$s,timeZone:$tz},
          end:{dateTime:$e,timeZone:$tz},
          attendees:$att,
          conferenceData:{createRequest:{requestId:("req-"+(now|tostring)),conferenceSolutionKey:{type:"hangoutsMeet"}}}}')"

Notes:
- `conferenceDataVersion: 1` is **required** to create a Meet link
- `sendUpdates: "all"` sends invite emails to attendees
- The Meet link comes back in the response under `.conferenceData.entryPoints[].uri` (or `.hangoutLink`)

To add a description or location, include `description` / `location` in the JSON body.

### Update an event

    gws calendar events patch --params '{"calendarId":"primary","eventId":"<eventId>","sendUpdates":"all"}' \
      --json '{"summary":"New Title","start":{"dateTime":"2026-03-16T14:00:00","timeZone":"America/New_York"},"end":{"dateTime":"2026-03-16T15:00:00","timeZone":"America/New_York"}}'

`patch` is partial-update — only fields you include are changed. Use `update` for full replacement.

To add attendees without losing existing ones, fetch the event first, append to the `attendees` array, then `patch`.

### Cancel an event (sends cancellation notices)

    gws calendar events delete --params '{"calendarId":"primary","eventId":"<eventId>","sendUpdates":"all"}'

### Check free/busy

    gws calendar freebusy query --params '{}' \
      --json '{"timeMin":"2026-03-15T09:00:00-05:00","timeMax":"2026-03-15T17:00:00-05:00","items":[{"id":"primary"}]}'

Returns `.calendars.primary.busy[]` with `start`/`end` of each busy slot. Empty array = free.

### Schema lookup

    gws schema calendar.events.insert
    gws schema calendar.events.patch
    gws schema calendar.freebusy.query

## CRITICAL: Day-of-Week Verification

**NEVER assume a date from a day name** (e.g. "Monday", "next Thursday"). Always verify before creating an event:

    python3 -c "from datetime import date; d = date(2026, 3, 15); print(f'{d.strftime(\"%A\")} {d}')"

If the output day name does NOT match what was requested, find the correct date. This is a **blocking requirement** — getting the day wrong sends a wrong invite to a real person.

## Workflow

1. If the user doesn't specify a time, list the next 7 days first
2. **If a day name was mentioned, verify the date matches that day**
3. Run `freebusy` for the proposed slot
4. Build the event JSON (always include Meet unless explicitly told not to)
5. Show the user the full plan (title, day-of-week + date + time, attendees, Meet yes/no) and get confirmation
6. Run `events insert`
7. Confirm with the Meet link from the response

## Confirmation Before Creating

Always show the user before running `insert`:
- Title
- **Day of week + Date/time** (e.g. "Monday Mar 15, 12:00 PM ET")
- Duration
- Attendees
- Meet: yes/no

Then ask for confirmation. Never run `insert` without it.

## Datetime Formats

- `dateTime` is RFC3339: `2026-03-15T10:00:00` plus a separate `timeZone` field (preferred), or `2026-03-15T10:00:00-05:00` with offset
- `date` (all-day events): `2026-03-15`

## Defaults

- Duration: 30 minutes unless specified
- Always include Meet link (`conferenceData` block) unless the user says no video
- `sendUpdates: "all"` so attendees actually get the invite
- Default timezone: `America/New_York` (joetroyer@gmail.com is ET)

## Auth / re-scope

    gws auth login -s gmail,calendar,drive,sheets,docs
    gws auth status

After scope changes, `rm ~/.config/gws/token_cache.json`.
