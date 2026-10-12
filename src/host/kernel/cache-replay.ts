#!/usr/bin/env node
// Host cache replay harness. Prompt envelopes, cache policy, and session
// lineage are Host concerns; the Kernel supplies only provider-neutral context
// segments to this measurement harness.

import path from 'node:path';
import process from 'node:process';
import { readFile, readdir } from 'node:fs/promises';
import { isDirectEntrypoint, resolveRuntimeRoot } from '../../shared/runtime-assets.js';
import { buildKernelContextSegments } from './context-segments.js';
import { buildPromptEnvelope } from './prompt-envelope.js';
import { buildToolManifest } from './tool-manifest.js';
import { resolveSessionLineage } from './session-affinity.js';
import type { SessionIdentity } from './session-affinity.js';
import { resolveOptimizationModes } from './provider-prompt-policy.js';

type UnknownRecord = Record<string, unknown>;

interface ReplayTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

interface ReplayTurn {
  stage?: string;
  surface?: string;
  role?: string;
  action?: string;
  riskTier?: string;
  hostStable?: UnknownRecord;
  projectStable?: UnknownRecord;
  runStable?: UnknownRecord;
  volatile?: UnknownRecord;
  tools?: ReplayTool[];
  modelPolicy?: UnknownRecord;
  capabilities?: UnknownRecord;
  control?: UnknownRecord;
}

interface ReplayFixture {
  name: string;
  before: ReplayTurn;
  after: ReplayTurn;
  expectedChangedSegments?: string[];
  expectedPrefixStable?: boolean | null;
}

interface ReplaySegment {
  kind: string;
  digest: string;
  cacheable: boolean;
  tokenEstimate: number;
}

interface ReplayCacheIdentity extends SessionIdentity {
  prefixDigest: string;
}

interface ReplayEnvelope {
  segments: readonly ReplaySegment[];
  cacheIdentity: ReplayCacheIdentity;
}

interface ReplayContext {
  segments: unknown[];
  [key: string]: unknown;
}

export const DEFAULT_FIXTURE_DIR = path.resolve(
  resolveRuntimeRoot(import.meta.url),
  'tests/fixtures/kernel-cache-replay',
);

const asRecord = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const compileContext = buildKernelContextSegments;
const compileEnvelope = buildPromptEnvelope;

const normalizeFixture = (value: unknown, file: string): ReplayFixture => {
  const record = asRecord(value);
  const before = asRecord(record?.before);
  const after = asRecord(record?.after);
  if (!record || !before || !after) {
    throw new TypeError(`invalid cache replay fixture: ${file}`);
  }
  return {
    name: String(record.name || file),
    before: before as ReplayTurn,
    after: after as ReplayTurn,
    expectedChangedSegments: Array.isArray(record.expectedChangedSegments)
      ? record.expectedChangedSegments.map(String)
      : [],
    expectedPrefixStable: typeof record.expectedPrefixStable === 'boolean'
      ? record.expectedPrefixStable
      : null,
  };
};

const compileTurn = (
  turn: ReplayTurn = {},
  {
    provider = 'claude',
    env = process.env,
  }: {
    provider?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) => {
  const context = compileContext({
    stage: turn.stage || 'EXECUTE',
    hostStable: turn.hostStable || {},
    projectStable: turn.projectStable || {},
    runStable: turn.runStable || {},
    volatile: turn.volatile || {},
  });
  const toolManifest = buildToolManifest(turn.tools || []);
  const envelope = compileEnvelope({
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

const segmentDigests = (
  envelope: ReplayEnvelope,
): Record<string, string> => Object.fromEntries(
  envelope.segments.map((segment) => [segment.kind, segment.digest]),
);

export const replayFixture = (
  fixture: ReplayFixture,
  {
    provider = 'claude',
    env = process.env,
  }: {
    provider?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) => {
  const before = compileTurn(fixture.before, { provider, env });
  const after = compileTurn(fixture.after, { provider, env });
  const beforeDigests = segmentDigests(before.envelope);
  const afterDigests = segmentDigests(after.envelope);
  const changedSegments = Object.keys(beforeDigests)
    .filter((kind) => beforeDigests[kind] !== afterDigests[kind])
    .sort();
  const expected = [...(fixture.expectedChangedSegments || [])].sort();

  const lineage = resolveSessionLineage({
    previous: {
      ...before.envelope.cacheIdentity,
      sessionLineageId: 'lineage-before',
    },
    current: after.envelope.cacheIdentity,
    role: fixture.after.role || fixture.before.role || 'implementer',
  });

  const eligiblePrefixTokens = before.envelope.segments
    .filter((segment) => segment.cacheable)
    .reduce((total, segment) => total + segment.tokenEstimate, 0);

  return {
    name: fixture.name,
    provider,
    prefixStable:
      before.envelope.cacheIdentity.prefixDigest
      === after.envelope.cacheIdentity.prefixDigest,
    expectedPrefixStable: fixture.expectedPrefixStable ?? null,
    changedSegments,
    expectedChangedSegments: expected,
    matchesExpectation:
      JSON.stringify(changedSegments) === JSON.stringify(expected),
    sessionContinued: lineage.continued,
    sessionResetReasons: lineage.resetReasons,
    eligiblePrefixTokens,
    volatileTokens:
      after.envelope.segments.find((segment) => segment.kind === 'volatile')
        ?.tokenEstimate ?? 0,
  };
};

export const loadFixtures = async (
  dir = DEFAULT_FIXTURE_DIR,
): Promise<ReplayFixture[]> => {
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.json'))
    .sort();
  return Promise.all(files.map(async (file) => {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dir, file), 'utf8'),
    );
    return normalizeFixture(parsed, file);
  }));
};

export const runCacheReplay = async ({
  dir = DEFAULT_FIXTURE_DIR,
  providers = ['claude', 'codex'],
  env = process.env,
}: {
  dir?: string;
  providers?: readonly string[];
  env?: NodeJS.ProcessEnv;
} = {}) => {
  const fixtures = await loadFixtures(dir);
  const results = fixtures.flatMap((fixture) => (
    providers.map((provider) => replayFixture(fixture, { provider, env }))
  ));
  return {
    schemaVersion: 1 as const,
    modes: resolveOptimizationModes(env),
    fixtures: fixtures.length,
    providers,
    results,
    failures: results.filter((result) => (
      !result.matchesExpectation
      || (
        result.expectedPrefixStable !== null
        && result.prefixStable !== result.expectedPrefixStable
      )
    )),
  };
};

if (isDirectEntrypoint(import.meta.url)) {
  const report = await runCacheReplay();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failures.length ? 1 : 0;
}
