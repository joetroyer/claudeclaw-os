---
name: gmail
description: Manage your Gmail inbox via the `gws` CLI. List, read, triage, reply, send, and create filters.
allowed-tools: Bash(gws *), Bash(git rev-parse *), Bash(jq *)
---

# Gmail Skill

## Purpose

Read, triage, reply, and send emails for joetroyer@gmail.com via the Google Workspace CLI (`gws`).

## Backend

Uses `gws` (`@googleworkspace/cli`), already installed and authed at `~/.config/gws/`. All output is structured JSON — pipe through `jq`.

If you see `403 insufficient authentication scopes`, run `rm ~/.config/gws/token_cache.json` and retry. That forces a token refresh from the stored refresh-token.

## Commands

### List inbox grouped by thread (default)

    gws gmail users threads list --params '{"userId":"me","labelIds":["INBOX"],"maxResults":50}'

For per-thread metadata (subject/from):

    gws gmail users threads get --params '{"userId":"me","id":"<threadId>","format":"metadata"}'

**Default behavior:** show inbox grouped by thread unless the user specifies a filter.

### List with a Gmail search query

    gws gmail users messages list --params '{"userId":"me","q":"is:unread newer_than:2d","maxResults":50}'

Gmail query syntax: `is:unread`, `from:x@y.com`, `to:me`, `newer_than:7d`, `has:attachment`, `subject:"…"`. Combine with spaces (AND) or `OR`.

### Read full email

    gws gmail users messages get --params '{"userId":"me","id":"<msgId>","format":"full"}'

`format` options: `minimal`, `metadata`, `full`, `raw`.

### List labels

    gws gmail users labels list --params '{"userId":"me"}'

### Move email to a label (auto-create if missing, archive, mark read)

    LABEL_NAME="My Label"
    LABEL_ID=$(gws gmail users labels list --params '{"userId":"me"}' \
      | jq -r --arg n "$LABEL_NAME" '.labels[] | select(.name==$n) | .id')
    if [ -z "$LABEL_ID" ]; then
      LABEL_ID=$(gws gmail users labels create --params '{"userId":"me"}' \
        --json "$(jq -nc --arg n "$LABEL_NAME" '{name:$n,labelListVisibility:"labelShow",messageListVisibility:"show"}')" \
        | jq -r '.id')
    fi
    gws gmail users messages modify --params '{"userId":"me","id":"<msgId>"}' \
      --json "$(jq -nc --arg lid "$LABEL_ID" '{addLabelIds:[$lid],removeLabelIds:["INBOX","UNREAD"]}')"

### Reply (preserves thread + In-Reply-To headers)

    MSG_ID="<original msg id>"; BODY="Your reply"
    META=$(gws gmail users messages get --params "$(jq -nc --arg id "$MSG_ID" '{userId:"me",id:$id,format:"metadata",metadataHeaders:["From","Subject","Message-ID"]}')")
    TO=$(echo "$META"   | jq -r '.payload.headers[] | select(.name=="From") | .value')
    SUBJ=$(echo "$META" | jq -r '.payload.headers[] | select(.name=="Subject") | .value')
    MID=$(echo "$META"  | jq -r '.payload.headers[] | select(.name|ascii_downcase=="message-id") | .value')
    THREAD=$(echo "$META" | jq -r '.threadId')
    RAW=$(printf 'To: %s\nSubject: Re: %s\nIn-Reply-To: %s\nReferences: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s' \
      "$TO" "${SUBJ#Re: }" "$MID" "$MID" "$BODY" | base64 | tr '+/' '-_' | tr -d '=\n')
    gws gmail users messages send --params '{"userId":"me"}' \
      --json "$(jq -nc --arg raw "$RAW" --arg tid "$THREAD" '{raw:$raw,threadId:$tid}')"

For attachments, build a `multipart/mixed` MIME — ask the user if they need a recipe.

### Send a new email

    TO="to@example.com"; SUBJ="Subject"; BODY="Body"
    RAW=$(printf 'To: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s' "$TO" "$SUBJ" "$BODY" \
      | base64 | tr '+/' '-_' | tr -d '=\n')
    gws gmail users messages send --params '{"userId":"me"}' --json "$(jq -nc --arg raw "$RAW" '{raw:$raw}')"

### Create a filter (auto-sort rule)

    # Get $LABEL_ID via the Move recipe first
    gws gmail users settings filters create --params '{"userId":"me"}' \
      --json "$(jq -nc --arg lid "$LABEL_ID" '{criteria:{from:"sender@example.com"},action:{addLabelIds:[$lid],removeLabelIds:["INBOX"]}}')"

Action keys: `addLabelIds`, `removeLabelIds` (use `INBOX` to archive, `UNREAD` to mark read), `forward`.

### List existing filters

    gws gmail users settings filters list --params '{"userId":"me"}'

### Schema lookup when stuck

    gws schema gmail.users.messages.list
    gws schema gmail.users.threads.get

## Workflow (default for "show me my email")

1. Run threads list → get inbox grouped by thread
2. Get metadata per thread (subject, from, last snippet)
3. Display as the markdown table below
4. Ask the user which to act on
5. Execute moves/replies, confirm results

## Display Format

| # | Unread | From | Subject | Replies | Time |
|---|--------|------|---------|---------|------|
| 1 | * | someone@example.com | Re: Project update | 3 | 2h ago |
| 2 | | newsletter@co.com | Your weekly digest | 1 | 5h ago |

One row per thread, not per message. `Replies` = thread message count.

## Drafting Rules

- Always draft email content and show the user before sending
- Never send without confirmation in that turn
- For replies, preserve the thread (`threadId` + `In-Reply-To`)

## Auth / re-scope

    gws auth login -s gmail,calendar,drive,sheets,docs   # broaden scopes
    gws auth status

After scope changes or `gws` upgrades, `rm ~/.config/gws/token_cache.json` to force a fresh access token.
