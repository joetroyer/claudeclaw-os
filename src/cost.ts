/**
 * Slice 5 — Cost / Token Tracking + Performance Scorecard.
 *
 * Loads pricing.yaml from repo root and computes per-(platform, model)
 * dollar cost from token counts. Subscription platforms always return
 * cost = 0 with subscription_flag = 1 so the UI can show a badge
 * instead of "$0".
 *
 * This module is read-only with respect to token_usage. It does NOT
 * write a column. Cost rollups are computed at query time in
 * src/scorecard.ts so we can adjust pricing without rewriting history.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { PROJECT_ROOT } from './config.js';

interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

interface PlatformEntry {
  /** When true, this whole platform is a flat-fee subscription (Claude Max,
   *  ChatGPT Pro, etc.). All cost calls return 0 with a subscription flag. */
  subscription?: boolean;
  /** Default model id to fall back to when the requested model is missing. */
  default?: string;
  /** Per-model price table. Keys are model ids; values are input/output rates. */
  models: Record<string, ModelPrice>;
}

interface PricingFile {
  version: number;
  platforms: Record<string, PlatformEntry>;
}

/** A single cost result. `subscription_flag` mirrors the spec language. */
export interface CostResult {
  cost: number;
  /** 1 = this came from a subscription platform (cost is 0 by design). */
  subscription_flag: 0 | 1;
  /** How the price was resolved. Useful for debugging missing entries. */
  source: 'exact' | 'platform-default' | 'subscription' | 'unknown';
}

/** Loaded once per process. Use loadPricing() to get a fresh copy in tests. */
let _cached: PricingFile | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/** Resolve the on-disk path of pricing.yaml. Honors PROJECT_ROOT so tests
 *  and worktrees pick the right copy. */
export function pricingFilePath(): string {
  return path.join(PROJECT_ROOT, 'pricing.yaml');
}

/** Read pricing.yaml from disk. Throws if the file is malformed; returns
 *  an empty platforms map if the file is missing so the rest of the app
 *  keeps booting (cost will just be 0 everywhere with source='unknown'). */
export function loadPricing(force = false): PricingFile {
  const now = Date.now();
  if (!force && _cached && now - _cachedAt < CACHE_TTL_MS) return _cached;

  const filePath = pricingFilePath();
  if (!fs.existsSync(filePath)) {
    _cached = { version: 1, platforms: {} };
    _cachedAt = now;
    return _cached;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw) as PricingFile | null;
  if (!parsed || typeof parsed !== 'object' || !('platforms' in parsed)) {
    throw new Error(`pricing.yaml malformed: expected { version, platforms }`);
  }
  _cached = { version: parsed.version ?? 1, platforms: parsed.platforms ?? {} };
  _cachedAt = now;
  return _cached;
}

/** Hard-reset the in-process cache. Test hook; not for runtime. */
export function _resetPricingCacheForTests(): void {
  _cached = null;
  _cachedAt = 0;
}

/**
 * Compute USD cost for a single turn given (platform, model, input, output).
 *
 * - Subscription platforms always return { cost: 0, subscription_flag: 1 }.
 * - API platforms look up the exact model, then fall back to the
 *   platform's `default` model, then return { cost: 0, source: 'unknown' }.
 * - Token counts are taken at face value; we don't try to subtract cache
 *   read here because the token_usage row already separates those columns
 *   if the caller wants to bill them differently.
 */
export function computeCost(
  platform: string | null | undefined,
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): CostResult {
  const pricing = loadPricing();
  const platformKey = (platform ?? '').trim().toLowerCase();
  const modelKey = (model ?? '').trim();

  if (!platformKey) {
    return { cost: 0, subscription_flag: 0, source: 'unknown' };
  }

  const platformEntry = pricing.platforms[platformKey];
  if (!platformEntry) {
    return { cost: 0, subscription_flag: 0, source: 'unknown' };
  }

  if (platformEntry.subscription) {
    return { cost: 0, subscription_flag: 1, source: 'subscription' };
  }

  const exact = modelKey ? platformEntry.models[modelKey] : undefined;
  if (exact) {
    return {
      cost: priceFor(exact, inputTokens, outputTokens),
      subscription_flag: 0,
      source: 'exact',
    };
  }

  const fallbackId = platformEntry.default;
  const fallback = fallbackId ? platformEntry.models[fallbackId] : undefined;
  if (fallback) {
    return {
      cost: priceFor(fallback, inputTokens, outputTokens),
      subscription_flag: 0,
      source: 'platform-default',
    };
  }

  return { cost: 0, subscription_flag: 0, source: 'unknown' };
}

function priceFor(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const perMillion = 1_000_000;
  const i = (inputTokens || 0) / perMillion;
  const o = (outputTokens || 0) / perMillion;
  return i * price.input + o * price.output;
}

/** True if this (platform, model) combination is a subscription. Used by
 *  the scorecard renderer to show the "subscription" badge instead of $0. */
export function isSubscription(platform: string | null | undefined): boolean {
  if (!platform) return false;
  const pricing = loadPricing();
  const entry = pricing.platforms[platform.trim().toLowerCase()];
  return !!entry?.subscription;
}

/** All known platform ids. Useful for UI dropdowns / validation. */
export function listPlatforms(): string[] {
  return Object.keys(loadPricing().platforms);
}
