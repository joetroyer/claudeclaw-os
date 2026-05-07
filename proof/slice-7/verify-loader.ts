/**
 * Slice 7 — verify the generated agent passes the Slice 1 loader exercise.
 *
 * Run from the repo root:
 *   DELIVERABILITY_EXPERT_BOT_TOKEN=fake-test-token \
 *     npx tsx proof/slice-7/verify-loader.ts
 *
 * The bot-token env var is required because src/agent-config.ts:loadAgentConfig
 * refuses to return without one. The token doesn't have to be real — we're
 * exercising the loader, not Telegram. The presence of the env var is enough.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// CRITICAL: src/config.ts reads CLAUDECLAW_CONFIG at module load. Set the env
// var BEFORE the agent-config import (which transitively imports config.ts).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sampleRoot = path.resolve(HERE, 'sample-generation');
process.env.CLAUDECLAW_CONFIG = sampleRoot;
console.log('CLAUDECLAW_CONFIG =', process.env.CLAUDECLAW_CONFIG);

const { loadAgentConfig, listAgentIds } = await import('../../src/agent-config.js');

const ids = listAgentIds();
console.log('Agents discovered:', ids);

if (!ids.includes('deliverability-expert')) {
  console.error('FAIL: generated agent not visible to listAgentIds()');
  process.exit(1);
}

const cfg = loadAgentConfig('deliverability-expert');
console.log('loadAgentConfig OK:');
console.log('  name        :', cfg.name);
console.log('  description :', cfg.description);
console.log('  model       :', cfg.model);
console.log('  botTokenEnv :', cfg.botTokenEnv);
console.log('  botToken set:', !!cfg.botToken);

// Verify all Slice 1 fields parse and are present
const yamlPath = path.join(sampleRoot, 'agents', 'deliverability-expert', 'agent.yaml');
const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any;
const required = ['four_rs', 'owns', 'lob', 'projects', 'ideal', 'platform', 'skills', 'avatar'];
const missing = required.filter((k) => !(k in raw));
if (missing.length > 0) {
  console.error('FAIL: missing Slice 1 keys:', missing);
  process.exit(1);
}
console.log('All Slice 1 fields present.');
console.log('  four_rs.results count :', raw.four_rs.results.length);
console.log('  skills.primary        :', JSON.stringify(raw.skills.primary));
console.log('  avatar                :', raw.avatar);
console.log('  platform              :', raw.platform);

// Verify CLAUDE.md has the house-style hard rules baked in
const claudeMd = fs.readFileSync(
  path.join(sampleRoot, 'agents', 'deliverability-expert', 'CLAUDE.md'),
  'utf-8',
);
const houseStyleChecks = [
  /No em dashes/,
  /No AI clichés/,
  /BLUF|bottom line/i,
  /## Background/,
  /## Style/,
  /## Hard rules/,
  /Hive mind/i,
  /\[SEND_FILE:/,
];
const missed = houseStyleChecks.filter((re) => !re.test(claudeMd));
if (missed.length > 0) {
  console.error('FAIL: CLAUDE.md missing required sections:', missed.map(String));
  process.exit(1);
}
console.log('CLAUDE.md house-style checks passed (', houseStyleChecks.length, 'patterns).');

// Verify avatar is a valid PNG
const avatarPath = path.join(sampleRoot, 'agents', 'deliverability-expert', 'avatar.png');
const avatar = fs.readFileSync(avatarPath);
const sig = avatar.subarray(0, 8);
const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (!sig.equals(expected)) {
  console.error('FAIL: avatar.png signature mismatch');
  process.exit(1);
}
console.log('avatar.png is a valid PNG (', avatar.length, 'bytes).');

// Verify launchd plist was generated and has placeholders
const plistPath = path.join(sampleRoot, 'launchd', 'com.claudeclaw.deliverability-expert.plist');
const plist = fs.readFileSync(plistPath, 'utf-8');
if (!plist.includes('__PROJECT_DIR__') || !plist.includes('__LOG_DIR__')) {
  console.error('FAIL: launchd plist missing placeholders for activateAgent');
  process.exit(1);
}
console.log('launchd plist has the expected placeholders.');

console.log('\nALL CHECKS PASSED.');
