# QA — voice note STT in /chat

## Manual smoke checklist

1. Open `/chat?token=...&chatId=...` in a browser. The composer row shows: textarea, mic button (Mic icon, neutral), Send button.
2. Click the mic button. Browser prompts for microphone permission. Accept.
3. Button enters recording state: red background, ring, pulsing Mic icon (filled).
4. Speak briefly (e.g. "this is a test voice note"). Click the mic button again.
5. Button switches to transcribing state: pulsing Sparkles icon, neutral background. Mic disabled while in flight.
6. Within ~1s the button returns to idle state and the transcribed text is inserted at the textarea cursor (or end if no caret). Composer keeps focus; caret sits at the end of the inserted text.
7. Edit the inserted text if desired. Press Enter — the message sends as a normal user turn (no special voice flag).

## Failure modes

- **Permission denied:** toast "Mic permission denied. Enable in browser settings, then refresh." Mic stays clickable in this session but immediately re-toasts; reload to retry.
- **MediaRecorder unsupported (very old browser):** mic button is hidden entirely, composer behaves identically to pre-mic build.
- **Empty audio (clicked stop too fast):** toast "No audio captured."
- **Groq error (5xx, network down, key missing):** toast "Transcription failed" with the upstream message.
- **Audio over 24 MB:** server returns 413; toast "Transcription failed" with size message. Browser-side recording for short voice notes won't hit this in practice.

## Backend coverage

`src/dashboard.transcribe.test.ts` (vitest) covers:
- 401 without token
- 413 on >24 MB upload
- 200 happy path with mocked Groq response
- 502 with upstream message on Groq 5xx

## Out of scope (intentional)

- No TTS reply path. Replies render as text only.
- No live voice / Pipecat. War Room voice mode is unchanged.
- No hold-to-record. Click-toggle only.
- No language hint or model override knob — defaults to `whisper-large-v3-turbo`.
