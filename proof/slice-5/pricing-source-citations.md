# pricing.yaml — source citations

The values in `/pricing.yaml` (repo root) are USD per **1M tokens**,
not per token. They were drafted from the public pricing pages listed
below, then rounded to easy-to-eyeball numbers so a reviewer can spot a
drift quickly.

If a price is wrong, edit `pricing.yaml` and the dashboard picks up the
new number on the next request (60s cache TTL). No data migration is
needed because cost is recomputed from tokens at query time.

## Anthropic Claude

Source of record: <https://www.anthropic.com/pricing> (and the model
spec pages under <https://docs.anthropic.com/claude/docs/models-overview>).

| Model | Input ($/1M) | Output ($/1M) | Notes |
|---|---|---|---|
| `claude-opus-4-7` | 15.00 | 75.00 | Opus tier (1M context preview included). |
| `claude-opus-4-6` | 15.00 | 75.00 | Same tier as 4-7. Kept as alias. |
| `claude-sonnet-4-6` | 3.00 | 15.00 | Sonnet 4.x family. |
| `claude-sonnet-4-5` | 3.00 | 15.00 | Same tier. |
| `claude-haiku-4-5` | 1.00 | 5.00 | Haiku 4.5 (most recent Haiku) |

Round numbers used: Anthropic's pricing page lists exact rates in
fractions; the eyeball rates here are easy to spot-check. If precise
billing matters, paste the exact decimals from the pricing page (e.g.
$1.10 for some Haiku revisions) and the rest of the system honours
them.

## OpenAI

Source of record: <https://openai.com/api/pricing/>.

| Model | Input ($/1M) | Output ($/1M) | Notes |
|---|---|---|---|
| `gpt-5` | 1.25 | 10.00 | GPT-5 standard tier. |
| `gpt-5-mini` | 0.25 | 2.00 | Smaller tier, conservative estimate. |

## Google Gemini

Source of record: <https://ai.google.dev/gemini-api/docs/pricing>.

| Model | Input ($/1M) | Output ($/1M) | Notes |
|---|---|---|---|
| `gemini-2.5-pro` | 1.25 | 10.00 | 2.5 Pro public pricing for ≤200K context. |
| `gemini-2.5-flash` | 0.30 | 2.50 | Flash tier. |
| `gemini-pro` | 1.25 | 10.00 | Legacy alias mapping to 2.5 Pro rates so older agent.yaml entries still resolve. |

Gemini pricing varies by context size on Pro (the docs split out
≤200K vs >200K tiers). The ≤200K rate is used here as the safe
default.

## OpenRouter

Source of record: <https://openrouter.ai/models>.

OpenRouter prices vary per upstream model. The pricing.yaml entry uses
`default: claude-sonnet-4-6` so unpinned OpenRouter agents are billed
at Sonnet rates by default — a safe upper bound for the dashboard. If
an agent uses a specific upstream model frequently, pin it explicitly
in the `models:` block.

## Subscription

Subscription is not a price; it's a flag. Setting an agent's `platform`
to `subscription` (e.g. Claude Max, ChatGPT Pro) tells `cost.ts` to
return `cost: 0` with `subscription_flag: 1`. Tokens are still
counted; dollars are not.

Use cases:

- A user is paying for Claude Max and wants to track usage but not
  attribute API spend.
- A team flat-funds an agent on a paid tier of any platform.

## Spot-check workflow

A reviewer who suspects a rate is wrong:

1. Open the upstream pricing page for the platform.
2. Compare the input/output rates here.
3. Edit `pricing.yaml` (no code changes needed; YAML reload happens on
   the next API call after the 60s cache TTL).
4. Hit `/api/scorecard?window=all` and confirm the costs shifted as
   expected.

Tracker: keep this file in sync with whatever the pricing pages say.
Drift is fine for the scorecard (it's reporting, not billing) — what's
not fine is leaving an unverifiable number around with no source.
