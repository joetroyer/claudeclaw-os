// Tests for POST /api/transcribe — the Groq Whisper passthrough behind
// the dashboard token gate. Covers:
//   - 401 without a token (auth gate must apply to this endpoint)
//   - 413 on uploads larger than 24 MB (server-side guard before we even
//     try to forward to Groq)
//   - 200 happy path (Groq mocked to return canned transcript text)
//   - 502 on upstream Groq error (Groq mocked with 5xx)
//
// Hono's `app.request()` runs the route in-process — no real port. We
// stub global `fetch` to intercept the outbound Groq call, so no network
// traffic leaves the test runner.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;
const realFetch = globalThis.fetch;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
  // Endpoint reads GROQ_API_KEY at request time; setting it here is
  // enough — config.ts already evaluated at import without it.
  process.env.GROQ_API_KEY = 'gsk_test_dummy';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function makeAudioForm(bytes: Uint8Array, name = 'voice.webm', type = 'audio/webm'): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return fd;
}

describe('POST /api/transcribe', () => {
  it('rejects without a token (401)', async () => {
    const res = await app.request('/api/transcribe', {
      method: 'POST',
      body: makeAudioForm(new Uint8Array([1, 2, 3])),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an audio blob over 24 MB with 413', async () => {
    // 25 MB of zeros — over the 24 MB guard. Big-but-not-huge so the
    // test stays fast on CI (allocates ~25 MB once).
    const big = new Uint8Array(25 * 1024 * 1024);
    const res = await app.request('/api/transcribe' + Q, {
      method: 'POST',
      body: makeAudioForm(big),
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('returns 200 + { text } on Groq success (mocked)', async () => {
    // Stub global fetch — return the bare transcript as plain text, the
    // shape Groq emits when response_format=text.
    globalThis.fetch = vi.fn(async () => {
      return new Response('hello world from groq', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const res = await app.request('/api/transcribe' + Q, {
      method: 'POST',
      body: makeAudioForm(new Uint8Array([0xFF, 0xFB, 0x90, 0x00])),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { text: string };
    expect(body.text).toBe('hello world from groq');

    // Sanity: we forwarded to Groq's transcriptions endpoint.
    const calls = (globalThis.fetch as unknown as { mock: { calls: any[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0][0])).toContain('api.groq.com/openai/v1/audio/transcriptions');
  });

  it('returns 502 with upstream message on Groq 5xx', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('whisper temporarily unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const res = await app.request('/api/transcribe' + Q, {
      method: 'POST',
      body: makeAudioForm(new Uint8Array([1, 2, 3, 4])),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('whisper temporarily unavailable');
  });
});
