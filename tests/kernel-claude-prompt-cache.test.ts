import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeCacheBreakpoints, CLAUDE_CACHE_BREAKPOINT_SEGMENTS } from '../src/host/kernel/claude-effort-policy.js';
import { buildPromptEnvelope } from '../src/host/kernel/prompt-envelope.js';
import { buildToolManifest } from '../src/host/kernel/tool-manifest.js';
import { buildKernelContextSegments } from '../src/host/kernel/context-segments.js';
import { CLAUDE_CAPABILITIES } from '../src/host/kernel/adapters/claude.js';

const envelope = (tools = [{ name: 'read_file', description: 'Read a file' }]) => buildPromptEnvelope({
  provider: 'claude',
  toolManifest: buildToolManifest(tools),
  contextSegments: buildKernelContextSegments({
    projectStable: { policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Provider-neutral core.' }] },
    runStable: { objective: 'Stabilize the prefix.' },
    volatile: { step: { stepId: 'step-1' } },
  }).segments,
  capabilities: CLAUDE_CAPABILITIES,
});

test('Claude declares explicit cache support and separate read/write counting', () => {
  assert.equal(CLAUDE_CAPABILITIES.supportsPromptCache, true);
  assert.equal(CLAUDE_CAPABILITIES.supportsExplicitCacheBreakpoints, true);
  assert.equal(CLAUDE_CAPABILITIES.supportsCacheReadTokens, true);
  assert.equal(CLAUDE_CAPABILITIES.supportsCacheWriteTokens, true);
});

test('breakpoints land at the end of each cacheable prefix', () => {
  const breakpoints = resolveClaudeCacheBreakpoints(envelope().segments);
  assert.deepEqual(breakpoints.map((b) => b.kind), [...CLAUDE_CACHE_BREAKPOINT_SEGMENTS]);
  for (const breakpoint of breakpoints) assert.match(breakpoint.digest, /^sha256:/);
});

test('the volatile tail never carries a breakpoint', () => {
  const breakpoints = resolveClaudeCacheBreakpoints(envelope().segments);
  assert.ok(!breakpoints.some((b) => b.kind === 'volatile'));
});

test('breakpoints are bounded, keeping the longest prefixes', () => {
  const breakpoints = resolveClaudeCacheBreakpoints(envelope().segments, { maxBreakpoints: 2 });
  assert.equal(breakpoints.length, 2);
  assert.deepEqual(breakpoints.map((b) => b.kind), ['provider-stable', 'run-stable']);
});

test('a tool manifest change moves the first breakpoint and everything behind it', () => {
  const before = resolveClaudeCacheBreakpoints(envelope().segments);
  const after = resolveClaudeCacheBreakpoints(envelope([{ name: 'read_file', description: 'Read a file, differently' }]).segments);
  const toolDigestBefore = before.find((b) => b.kind === 'tool-stable');
  const toolDigestAfter = after.find((b) => b.kind === 'tool-stable');
  assert.ok(toolDigestBefore && toolDigestAfter);
  assert.notEqual(toolDigestBefore.digest, toolDigestAfter.digest);
});

test('the Host context segment builder does not generate cache_control markers', async () => {
  const { readFile } = await import('node:fs/promises');
  const core = await readFile('scripts/host/kernel/context-segments.js', 'utf8');
  assert.doesNotMatch(core, /cache_control/);
});
