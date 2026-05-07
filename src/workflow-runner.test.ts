/**
 * Slice 6 — Unit tests for the deterministic pieces of the workflow
 * runner / spawner. The actual SDK invocation is covered by the
 * integration smoke in proof/slice-6/.
 */
import { describe, expect, it } from 'vitest';

import path from 'path';

import { evaluateConsensus } from './workflow-runner.js';
import { buildDenyEditHook, parseVerdict } from './workflow-spawner.js';
import { effectiveAllowedPaths } from './workflow-loader.js';
import { PROJECT_ROOT } from './config.js';

describe('Slice 6 · evaluateConsensus', () => {
  it('majority: 2-of-3 approvals passes', () => {
    expect(evaluateConsensus(['APPROVED', 'APPROVED', 'REJECTED'], 'majority').consensus).toBe(true);
  });
  it('majority: 1-of-3 approvals fails', () => {
    expect(evaluateConsensus(['APPROVED', 'REJECTED', 'REJECTED'], 'majority').consensus).toBe(false);
  });
  it('majority: 1-of-2 (tie) fails (strictly more than half)', () => {
    expect(evaluateConsensus(['APPROVED', 'REJECTED'], 'majority').consensus).toBe(false);
  });
  it('unanimous: all-approved passes', () => {
    expect(evaluateConsensus(['APPROVED', 'APPROVED', 'APPROVED'], 'unanimous').consensus).toBe(true);
  });
  it('unanimous: any rejection fails', () => {
    expect(evaluateConsensus(['APPROVED', 'APPROVED', 'REJECTED'], 'unanimous').consensus).toBe(false);
  });
  it('unanimous: all UNKNOWN fails', () => {
    expect(evaluateConsensus(['UNKNOWN', 'UNKNOWN'], 'unanimous').consensus).toBe(false);
  });
  it('threshold: 2-of-3 with threshold 2 passes', () => {
    expect(evaluateConsensus(['APPROVED', 'APPROVED', 'REJECTED'], 'threshold', 2).consensus).toBe(true);
  });
  it('threshold: 1-of-3 with threshold 2 fails', () => {
    expect(evaluateConsensus(['APPROVED', 'REJECTED', 'REJECTED'], 'threshold', 2).consensus).toBe(false);
  });
});

describe('Slice 6 · parseVerdict', () => {
  it('parses trailing APPROVED', () => {
    expect(parseVerdict('blah blah\nVERDICT: APPROVED')).toBe('APPROVED');
  });
  it('parses trailing REJECTED', () => {
    expect(parseVerdict('blah\n\nVERDICT: REJECTED\n')).toBe('REJECTED');
  });
  it('case-insensitive', () => {
    expect(parseVerdict('verdict: approved')).toBe('APPROVED');
  });
  it('uses the LAST verdict line if multiple', () => {
    expect(parseVerdict('VERDICT: APPROVED ... later: VERDICT: REJECTED')).toBe('REJECTED');
  });
  it('UNKNOWN when missing', () => {
    expect(parseVerdict('no verdict here')).toBe('UNKNOWN');
  });
  it('UNKNOWN on null', () => {
    expect(parseVerdict(null)).toBe('UNKNOWN');
  });
});

describe('Slice 6 · effectiveAllowedPaths', () => {
  it('merges workflow-level and stage-level paths', () => {
    const paths = effectiveAllowedPaths(
      { slug: 's', title: 't', stages: [], allowed_paths: ['memory/', 'tasks.md'] } as any,
      { name: 'x', type: 'sequential', agent: 'a', prompt: 'p',
        allowed_paths: ['plans/'],
        on_failure: { retries: 0, escalate_to: 'meta' } } as any,
    );
    expect(paths.sort()).toEqual(['memory/', 'plans/', 'tasks.md']);
  });
});

describe('Slice 6 · buildDenyEditHook', () => {
  const mkInput = (toolName: string, filePath: string) => ({
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_use_id: 'toolu_test',
    permission_mode: 'default',
  });

  // Bash takes a `command`, not a `file_path`. Mirror the real SDK
  // shape so we exercise the unconditional-block branch correctly.
  const mkBashInput = (command: string) => ({
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_test',
    permission_mode: 'default',
  });

  it('blocks Edit on a path outside allowed_paths', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/', 'tasks.md'], blocks);
    const out = await hook(mkInput('Edit', path.join(PROJECT_ROOT, 'src/db.ts')) as any, undefined, { signal: new AbortController().signal });
    expect((out as any).decision).toBe('block');
    expect(blocks.length).toBe(1);
    expect(blocks[0].tool).toBe('Edit');
  });

  it('allows Edit inside an allowed directory prefix', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/', 'tasks.md'], blocks);
    const out = await hook(mkInput('Edit', path.join(PROJECT_ROOT, 'memory/notes.md')) as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
    expect(blocks.length).toBe(0);
  });

  it('allows Edit on an exact-file allowed path', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['tasks.md'], blocks);
    const out = await hook(mkInput('Edit', path.join(PROJECT_ROOT, 'tasks.md')) as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
  });

  it('blocks Bash unconditionally — even with allowed_paths set', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/', 'tasks.md', 'src/'], blocks);
    const out = await hook(mkBashInput('echo hello > /tmp/x.txt') as any, undefined, { signal: new AbortController().signal });
    expect((out as any).decision).toBe('block');
    expect(blocks.length).toBe(1);
    expect(blocks[0].tool).toBe('Bash');
  });

  it('blocks Bash when used as a write-bypass (cat > file)', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/'], blocks);
    const out = await hook(mkBashInput('cat > memory/notes.md <<EOF\npayload\nEOF') as any, undefined, { signal: new AbortController().signal });
    // Bash is blocked even when targeting a path inside allowed_paths.
    // Allowed-path writes must go through the Edit/Write tools so the
    // workflow runner can audit them.
    expect((out as any).decision).toBe('block');
    expect(blocks[0].tool).toBe('Bash');
  });

  it('blocks Bash with no allowed_paths set', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook([], blocks);
    const out = await hook(mkBashInput('ls') as any, undefined, { signal: new AbortController().signal });
    expect((out as any).decision).toBe('block');
  });

  it('blocks Write on a path outside allowed_paths', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/'], blocks);
    const out = await hook(mkInput('Write', path.join(PROJECT_ROOT, 'src/agent.ts')) as any, undefined, { signal: new AbortController().signal });
    expect((out as any).decision).toBe('block');
  });

  it('blocks MultiEdit on a path outside allowed_paths', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/'], blocks);
    const out = await hook(mkInput('MultiEdit', path.join(PROJECT_ROOT, 'src/agent.ts')) as any, undefined, { signal: new AbortController().signal });
    expect((out as any).decision).toBe('block');
    expect(blocks[0].tool).toBe('MultiEdit');
  });

  it('allows MultiEdit inside an allowed directory prefix', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/'], blocks);
    const out = await hook(mkInput('MultiEdit', path.join(PROJECT_ROOT, 'memory/notes.md')) as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
    expect(blocks.length).toBe(0);
  });

  it('blocks NotebookEdit outside allowed_paths via notebook_path key', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook(['memory/'], blocks);
    const out = await hook({
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: path.join(PROJECT_ROOT, 'src/foo.ipynb') },
      tool_use_id: 'toolu_test',
      permission_mode: 'default',
    } as any, undefined, { signal: new AbortController().signal });
    expect((out as any).decision).toBe('block');
  });

  it('does NOT block read-only tools (Read)', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook([], blocks);
    const out = await hook({
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Read',
      tool_input: { file_path: path.join(PROJECT_ROOT, 'src/agent.ts') },
      tool_use_id: 'toolu_test',
      permission_mode: 'default',
    } as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
    expect(blocks.length).toBe(0);
  });

  it('does NOT block read-only tools (Grep)', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook([], blocks);
    const out = await hook({
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
      tool_use_id: 'toolu_test',
      permission_mode: 'default',
    } as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
  });

  it('does NOT block read-only tools (Glob)', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook([], blocks);
    const out = await hook({
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts' },
      tool_use_id: 'toolu_test',
      permission_mode: 'default',
    } as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
  });

  it('does NOT block Task (sub-agent dispatch is the legitimate delegation path)', async () => {
    const blocks: any[] = [];
    const hook = buildDenyEditHook([], blocks);
    const out = await hook({
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Task',
      tool_input: { description: 'delegate', subagent_type: 'general' },
      tool_use_id: 'toolu_test',
      permission_mode: 'default',
    } as any, undefined, { signal: new AbortController().signal });
    expect((out as any).continue).toBe(true);
  });
});
