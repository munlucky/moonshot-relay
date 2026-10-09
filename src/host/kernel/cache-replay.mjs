#!/usr/bin/env node
// Host cache replay harness. Prompt envelopes, cache policy, and session
// lineage are Host concerns; the Kernel supplies only provider-neutral context
// segments to this measurement harness.

import path from 'node:path';
import process from 'node:process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildKernelContextSegments } from '../../kernel/context-segments.mjs';
import { buildPromptEnvelope } from './prompt-envelope.mjs';
import { buildToolManifest } from './tool-manifest.mjs';
import { resolveSessionLineage } from './session-affinity.mjs';
import { resolveOptimizationModes } from './provider-prompt-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_DIR = path.resolve(here, '../../../tests/fixtures/kernel-cache-replay');

const compileTurn = (turn = {}, { provider = 'claude', env = process.env } = {}) => {
  const context = buildKernelContextSegments({
    stage: turn.stage || 'EXECUTE',
    hostStable: turn.hostStable || {},
    projectStable: turn.projectStable || {},
    runStable: turn.runStable || {},
    volatile: turn.volatile || {},
  });
  const toolManifest = buildToolManifest(turn.tools || []);
  const envelope = buildPromptEnvelope({
    provider,
    surface: turn.surface || provider,
    role: turn.role || 'implementer',
    action: turn.action || 'implement',
    riskTier: turn.riskTier || 'T1',
    toolManifest,
    contextSegments: context.segments,
    modelPolicy: turn.modelPolicy || {},
    capabilities: turn.capabilities || {},
    control: turn.control || {},
    env,
  });
  return { context, toolManifest, envelope };
};

const segmentDigests = (envelope) =>
  Object.fromEntries(envelope.segments.map((segment) => [segment.kind, segment.digest]));

export const replayFixture = (fixture, { provider = 'claude', env = process.env } = {}) => {
  const before = compileTurn(fixture.before, { provider, env });
  const after = compileTurn(fixture.after, { provider, env });
  const beforeDigests = segmentDigests(before.envelope);
  const afterDigests = segmentDigests(after.envelope);
  const changedSegments = Object.keys(beforeDigests).filter((kind) => beforeDigests[kind] !== afterDigests[kind]).sort();
  const expected = [...(fixture.expectedChangedSegments || [])].sort();

  const lineage = resolveSessionLineage({
    previous: { ...before.envelope.cacheIdentity, sessionLineageId: 'lineage-before' },
    current: after.envelope.cacheIdentity,
    role: fixture.after?.role || fixture.before?.role || 'implementer',
  });

  const eligiblePrefixTokens = before.envelope.segments
    .filter((segment) => segment.cacheable)
    .reduce((total, segment) => total + segment.tokenEstimate, 0);

  return {
    name: fixture.name,
    provider,
    prefixStable: before.envelope.cacheIdentity.prefixDigest === after.envelope.cacheIdentity.prefixDigest,
    expectedPrefixStable: fixture.expectedPrefixStable ?? null,
    changedSegments,
    expectedChangedSegments: expected,
    matchesExpectation: JSON.stringify(changedSegments) === JSON.stringify(expected),
    sessionContinued: lineage.continued,
    sessionResetReasons: lineage.resetReasons,
    eligiblePrefixTokens,
    volatileTokens: after.envelope.segments.find((segment) => segment.kind === 'volatile')?.tokenEstimate ?? 0,
  };
};

export const loadFixtures = async (dir = DEFAULT_FIXTURE_DIR) => {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), 'utf8'))));
};

export const runCacheReplay = async ({ dir = DEFAULT_FIXTURE_DIR, providers = ['claude', 'codex'], env = process.env } = {}) => {
  const fixtures = await loadFixtures(dir);
  const results = fixtures.flatMap((fixture) => providers.map((provider) => replayFixture(fixture, { provider, env })));
  return {
    schemaVersion: 1,
    modes: resolveOptimizationModes(env),
    fixtures: fixtures.length,
    providers,
    results,
    failures: results.filter((result) => !result.matchesExpectation
      || (result.expectedPrefixStable !== null && result.prefixStable !== result.expectedPrefixStable)),
  };
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const report = await runCacheReplay();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failures.length ? 1 : 0;
}

