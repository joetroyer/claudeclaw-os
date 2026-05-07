/**
 * Slice 5 — pricing.yaml lookup + cost computation tests.
 *
 * Hits the real pricing.yaml at PROJECT_ROOT, so when an entry is added
 * or rates change these tests act as a tripwire on the values that
 * power the scorecard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computeCost, isSubscription, listPlatforms, loadPricing, _resetPricingCacheForTests } from './cost.js';

beforeEach(() => {
  _resetPricingCacheForTests();
});

describe('cost.ts — pricing.yaml loader', () => {
  it('loads the file and exposes platform keys', () => {
    const platforms = listPlatforms();
    expect(platforms).toContain('claude');
    expect(platforms).toContain('openai');
    expect(platforms).toContain('gemini');
    expect(platforms).toContain('subscription');
  });

  it('flags the subscription platform', () => {
    expect(isSubscription('subscription')).toBe(true);
    expect(isSubscription('claude')).toBe(false);
    expect(isSubscription('')).toBe(false);
    expect(isSubscription(undefined)).toBe(false);
  });

  it('exposes models on each platform', () => {
    const p = loadPricing();
    expect(p.platforms.claude.models['claude-opus-4-7']).toBeDefined();
    expect(p.platforms.claude.models['claude-sonnet-4-6']).toBeDefined();
    expect(p.platforms.claude.models['claude-haiku-4-5']).toBeDefined();
    expect(p.platforms.openai.models['gpt-5']).toBeDefined();
    expect(p.platforms.gemini.models['gemini-pro']).toBeDefined();
  });
});

describe('cost.ts — computeCost', () => {
  it('computes opus cost from 1M input + 1M output exactly from the table', () => {
    const r = computeCost('claude', 'claude-opus-4-7', 1_000_000, 1_000_000);
    expect(r.subscription_flag).toBe(0);
    expect(r.source).toBe('exact');
    // input 15 + output 75 per million → 90 USD.
    expect(r.cost).toBeCloseTo(90, 6);
  });

  it('falls back to platform default when model is unknown but platform is real', () => {
    const r = computeCost('claude', 'claude-not-released-yet', 100_000, 100_000);
    expect(r.source).toBe('platform-default');
    // sonnet-4-6 default: 3 in / 15 out → (0.3 + 1.5) = 1.8.
    expect(r.cost).toBeCloseTo(1.8, 6);
  });

  it('returns subscription flag for subscription platforms', () => {
    const r = computeCost('subscription', 'whatever', 1_000_000, 1_000_000);
    expect(r.cost).toBe(0);
    expect(r.subscription_flag).toBe(1);
    expect(r.source).toBe('subscription');
  });

  it('returns unknown source when platform is missing', () => {
    const r = computeCost('not-a-real-platform', 'gpt-5', 100, 100);
    expect(r.cost).toBe(0);
    expect(r.subscription_flag).toBe(0);
    expect(r.source).toBe('unknown');
  });

  it('handles empty/null inputs without throwing', () => {
    expect(computeCost(null, null, 0, 0).cost).toBe(0);
    expect(computeCost('', '', 0, 0).cost).toBe(0);
    expect(computeCost('claude', 'claude-opus-4-7', 0, 0).cost).toBe(0);
  });

  it('matches case-insensitively on platform', () => {
    const r = computeCost('Claude', 'claude-sonnet-4-6', 1_000_000, 0);
    expect(r.source).toBe('exact');
    expect(r.cost).toBeCloseTo(3, 6);
  });
});
