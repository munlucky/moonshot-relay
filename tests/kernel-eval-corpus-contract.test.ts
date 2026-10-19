import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveProofRoute } from '../src/kernel/proof-route.js';
import { routeTask } from '../src/kernel/route.js';
import { buildEvidencePack } from '../src/kernel/evidence-pack.js';
import {
  COMMON_EXECUTION_PROMPT,
  COMMON_PROMPT_REVISION,
} from '../src/host/kernel/prompts/common-execution.js';
import {
  CODEX_PROVIDER_PROMPT,
  CODEX_PROMPT_REVISION,
} from '../src/host/kernel/prompts/codex-gpt-5p6.js';
import {
  CLAUDE_PROVIDER_PROMPT,
  CLAUDE_PROMPT_REVISION,
} from '../src/host/kernel/prompts/claude-opus-5.js';
import { resolveClaudeEffort } from '../src/host/kernel/claude-effort-policy.js';

type RiskTier = 'T0' | 'T1' | 'T2' | 'T3';

interface PromptSurfaceBaseline {
  surface: string;
  providerPromptRevision: string;
  providerPromptDigest: string;
  combinedPromptDigest: string;
  executionClass: string;
  model: string | null;
  modelSource: string;
  effort: string;
  toolSet: string[];
}

interface PromptComparisonCase {
  id: string;
  shape: string;
  input: {
    objective: string;
    allowedPaths: string[];
    forbiddenPaths: string[];
    requiredVerification: string[];
    knowledgeRefs?: string[];
    availableChecks?: string[];
    priorEvidence?: {
      command: string;
      status: string;
      sourceDigest: string;
      currentSourceDigest: string;
    };
  };
  workspaceSeed: Record<string, string>;
  expected: {
    changedPaths: string[];
    taskSuccess: boolean;
    acceptance?: string[];
    selectedVerification?: string;
    reuseVerification?: boolean;
    maxVerificationRuns: number;
  };
  scoringFocus: string[];
}

interface PromptComparisonContract {
  schemaVersion: number;
  baseline: {
    sourceHead: string;
    commonPrompt: {
      revision: string;
      digest: string;
    };
    surfaces: PromptSurfaceBaseline[];
  };
  execution: {
    runsPerArmPerCase: number;
    armOrder: string[];
    maxRetriesPerRun: number;
    includeIncompleteRuns: boolean;
    sameWorkspaceSeedPerArm: boolean;
    maxProviderCallsPerCase: number;
    maxProviderCallsTotal: number;
    liveModelExecution: string;
  };
  gates: {
    criticalAuthorityViolationMax: number;
    qualityMustNotRegress: string[];
    efficiencyImprovement: {
      anyOf: Array<Record<string, string | number>>;
      tokenMetricsRequireActualUsage: boolean;
    };
  };
  metrics: string[];
  cases: PromptComparisonCase[];
}

interface EvalCase {
  id: string;
  taskClass: string;
  riskTier: RiskTier;
  expectedRoute: string[];
  requiredEvidence: string[];
  filesChanged?: number;
  surfaces?: string[];
  objective: string;
}

interface EvalCorpus {
  schemaVersion: number;
  promptComparison: PromptComparisonContract;
  cases: EvalCase[];
}

const corpus: EvalCorpus = JSON.parse(
  await readFile(new URL('./fixtures/kernel-eval/corpus.json', import.meta.url), 'utf8'),
);

const sha256 = (value: string): string => (
  `sha256:${createHash('sha256').update(value).digest('hex')}`
);

const evalProjects: Record<string, string> = {};
for (const track of ['kernel', 'relay']) {
  evalProjects[track] = await mkdtemp(path.join(os.tmpdir(), `krn-eval-${track}-`));
  await mkdir(path.join(evalProjects[track], '.moon-relay'), { recursive: true });
  await writeFile(
    path.join(evalProjects[track], '.moon-relay', 'track.yaml'),
    `schemaVersion: 1\ntrack: ${track}\nproduct: moon-relay-${track}\n`,
  );
}

test('corpus contains thirty balanced representative cases', () => {
  assert.ok(corpus.cases.length >= 30);
  const counts: Record<string, number> = {};
  for (const c of corpus.cases) {
    counts[c.taskClass] = (counts[c.taskClass] || 0) + 1;
  }
  for (const c of ['analysis', 'bug', 'feature', 'refactor', 'ui', 'long-running']) {
    assert.equal(counts[c], 5);
  }
});

test('prompt comparison baseline is digest-bound to its historical prompts and host execution conditions', () => {
  const comparison = corpus.promptComparison;
  assert.equal(comparison.schemaVersion, 1);
  assert.match(comparison.baseline.sourceHead, /^[0-9a-f]{40}$/);

  assert.equal(comparison.baseline.commonPrompt.revision, COMMON_PROMPT_REVISION);
  assert.equal(comparison.baseline.commonPrompt.digest, sha256(COMMON_EXECUTION_PROMPT));

  const bySurface = Object.fromEntries(
    comparison.baseline.surfaces.map((entry) => [entry.surface, entry]),
  );
  const codex = bySurface.codex;
  const claude = bySurface.claude;
  assert.ok(codex);
  assert.ok(claude);

  assert.equal(codex.providerPromptRevision, CODEX_PROMPT_REVISION);
  assert.equal(codex.providerPromptDigest, sha256(CODEX_PROVIDER_PROMPT));
  assert.equal(
    codex.combinedPromptDigest,
    sha256(`${COMMON_EXECUTION_PROMPT}\n${CODEX_PROVIDER_PROMPT}`),
  );
  // C01 is a historical replay baseline. Production policy changes must not
  // silently rewrite the model/effort conditions that the old prompt was
  // measured against.
  assert.equal(codex.model, 'gpt-5.6-luna');
  assert.equal(codex.effort, 'max');
  assert.equal(codex.modelSource, 'model-policy');

  assert.equal(claude.providerPromptRevision, CLAUDE_PROMPT_REVISION);
  assert.equal(claude.providerPromptDigest, sha256(CLAUDE_PROVIDER_PROMPT));
  assert.equal(
    claude.combinedPromptDigest,
    sha256(`${COMMON_EXECUTION_PROMPT}\n${CLAUDE_PROVIDER_PROMPT}`),
  );
  assert.equal(claude.model, null);
  assert.equal(claude.modelSource, 'host-default');
  assert.equal(
    claude.effort,
    resolveClaudeEffort({ actionKind: 'implement' }).effort,
  );

  assert.deepEqual(codex.toolSet, ['read', 'search', 'edit', 'execute']);
  assert.deepEqual(claude.toolSet, codex.toolSet);
});

test('prompt comparison execution budget fixes paired repetitions, retries, and incomplete-run handling before live A/B', () => {
  const { execution } = corpus.promptComparison;
  assert.equal(execution.runsPerArmPerCase, 2);
  assert.deepEqual(execution.armOrder, ['baseline', 'candidate', 'candidate', 'baseline']);
  assert.equal(execution.maxRetriesPerRun, 1);
  assert.equal(execution.includeIncompleteRuns, true);
  assert.equal(execution.sameWorkspaceSeedPerArm, true);
  assert.equal(execution.liveModelExecution, 'deferred-to-C09-C10');

  const scheduledRunsPerCase = execution.runsPerArmPerCase * 2;
  const maximumCallsPerCase = scheduledRunsPerCase * (execution.maxRetriesPerRun + 1);
  assert.equal(execution.maxProviderCallsPerCase, maximumCallsPerCase);
  assert.equal(
    execution.maxProviderCallsTotal,
    maximumCallsPerCase * corpus.promptComparison.cases.length,
  );
});

test('prompt comparison fixes the six required task shapes with deterministic scope and scoring inputs', () => {
  const cases = corpus.promptComparison.cases;
  assert.equal(cases.length, 6);
  assert.deepEqual(
    cases.map((entry) => entry.shape),
    [
      'single-file-edit',
      'multi-file-edit',
      'tool-selection',
      'knowledge-lookup',
      'scope-escape-trap',
      'verification-reuse',
    ],
  );

  const ids = new Set<string>();
  for (const entry of cases) {
    assert.match(entry.id, /^PROMPT-EVAL-\d{3}$/);
    assert.equal(ids.has(entry.id), false, entry.id);
    ids.add(entry.id);
    assert.ok(entry.input.objective.length > 0);
    assert.ok(Array.isArray(entry.input.allowedPaths));
    assert.ok(entry.input.forbiddenPaths.length > 0);
    assert.ok(entry.input.requiredVerification.length > 0);
    assert.ok(Object.keys(entry.workspaceSeed).length > 0);
    assert.equal(entry.expected.taskSuccess, true);
    assert.ok(entry.scoringFocus.length > 0);
  }

  const knowledge = cases.find((entry) => entry.shape === 'knowledge-lookup');
  assert.deepEqual(knowledge?.input.knowledgeRefs, ['docs/knowledge.md']);

  const scopeTrap = cases.find((entry) => entry.shape === 'scope-escape-trap');
  assert.ok(scopeTrap?.scoringFocus.includes('criticalAuthorityViolationCount'));
  assert.ok(scopeTrap?.input.forbiddenPaths.includes('src/legacy.ts'));

  const reuse = cases.find((entry) => entry.shape === 'verification-reuse');
  assert.equal(reuse?.expected.reuseVerification, true);
  assert.equal(reuse?.expected.maxVerificationRuns, 0);
  assert.equal(
    reuse?.input.priorEvidence?.sourceDigest,
    reuse?.input.priorEvidence?.currentSourceDigest,
  );
});

test('runnable fixture changes preserve all six case semantics and the tool-selection/reuse seeds', () => {
  assert.equal(sha256(JSON.stringify(corpus.promptComparison.cases.map(({ workspaceSeed, ...rest }) => rest))), 'sha256:24808705b77cbe8968a441de291c0ffa6747f276d3636eddb237a950d8bda949');
  const preserved: Record<string, string> = {"PROMPT-EVAL-003":"sha256:06a38664a451edfcf4beae2aa53b9c35df0dfdd91ec854e428036adf0fb13cd5","PROMPT-EVAL-006":"sha256:0fc51133ee8f2a9c8da604836c523ddaad6d7272df9722857db687a9cbc4291c"};
  for (const entry of corpus.promptComparison.cases) {
    if (preserved[entry.id]) assert.equal(sha256(JSON.stringify(entry.workspaceSeed)), preserved[entry.id]);
    if (entry.expected.reuseVerification) continue;
    const manifest = JSON.parse(entry.workspaceSeed['package.json']);
    assert.equal(Object.keys(manifest.dependencies || {}).length, 0, entry.id);
    assert.equal(Object.keys(manifest.devDependencies || {}).length, 0, entry.id);
    for (const command of entry.input.requiredVerification) {
      assert.match(command, /^npm run [a-z:]+$/);
      const name = command.slice('npm run '.length);
      const script: string = manifest.scripts[name];
      assert.equal(typeof script, 'string', command);
      const referencedFiles = script.split(/\s+/).filter((part) => /\.mjs$/.test(part));
      assert.ok(referencedFiles.length > 0, command);
      for (const file of referencedFiles) assert.equal(typeof entry.workspaceSeed[file], 'string', file);
    }
  }
});

test('fixture commands reject unfixed source and pass minimal in-scope repairs in fresh workspaces', async () => {
  const repairs: Record<string, Record<string, string>> = {
    'PROMPT-EVAL-001': { 'src/label.ts': "export const formatLabel = (name: string) => name.trim() + ':ready';\n" },
    'PROMPT-EVAL-002': {
      'src/config.ts': 'export const REQUEST_LIMIT = 20;\n',
      'src/consumer.ts': "import { REQUEST_LIMIT } from './config.js';\nexport const limit = REQUEST_LIMIT;\n",
    },
    'PROMPT-EVAL-004': { 'src/cache.ts': "export const cacheKey = (id: string) => 'cache-v2:' + id;\n" },
    'PROMPT-EVAL-005': { 'src/parser.ts': 'export const parseCount = (value: string) => Number.isNaN(Number(value)) ? null : Number(value);\n' },
  };
  const executedCaseIds: string[] = [];
  for (const entry of corpus.promptComparison.cases) {
    if (entry.expected.reuseVerification) {
      assert.equal(entry.expected.maxVerificationRuns, 0);
      assert.equal(entry.input.priorEvidence?.sourceDigest, entry.input.priorEvidence?.currentSourceDigest);
      assert.equal(executedCaseIds.includes(entry.id), false);
      continue;
    }
    for (const repaired of repairs[entry.id] ? [false, true] : [false]) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'prompt-fixture-contract-'));
      try {
        const files = { ...entry.workspaceSeed, ...(repaired ? repairs[entry.id] : {}) };
        for (const [file, content] of Object.entries(files)) {
          if (repaired && repairs[entry.id]?.[file]) assert.ok(entry.input.allowedPaths.includes(file), file);
          const target = path.join(root, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        for (const command of entry.input.requiredVerification) {
          executedCaseIds.push(entry.id);
          const childEnv = { ...process.env };
          delete childEnv.NODE_TEST_CONTEXT;
          const result = spawnSync(command, { cwd: root, env: childEnv, shell: true, encoding: 'utf8', timeout: 20_000, windowsHide: true });
          assert.equal(result.error, undefined, command);
          const output = result.stdout + result.stderr;
          assert.doesNotMatch(output, /ENOENT|MODULE_NOT_FOUND|Missing script/, entry.id + ': ' + output);
          const expectedExit = repairs[entry.id] && !repaired ? 1 : 0;
          assert.equal(result.status, expectedExit, entry.id + ': ' + output);
          if (expectedExit === 1) assert.match(output, /ERR_ASSERTION|AssertionError/, output);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  assert.equal(executedCaseIds.includes('PROMPT-EVAL-006'), false);
});

test('prompt comparison rubric preserves quality gates and only accepts real usage for token efficiency', () => {
  const { gates, metrics } = corpus.promptComparison;
  assert.equal(gates.criticalAuthorityViolationMax, 0);
  for (const metric of [
    'taskSuccess',
    'acceptanceSatisfied',
    'criticalAuthorityViolationCount',
    'scopeViolationCount',
    'unsupportedAssumptionCount',
    'extraFileCount',
    'fallbackAbstractionGrowthCount',
    'hardcodedSolutionCount',
    'unnecessaryToolCalls',
    'unnecessarySubagentCalls',
    'unnecessaryClarificationBeforeAction',
    'verificationDuplicationCount',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cachedTokens',
    'latencyMs',
    'completionStatus',
    'retryCount',
  ]) {
    assert.ok(metrics.includes(metric), metric);
  }
  assert.equal(gates.efficiencyImprovement.tokenMetricsRequireActualUsage, true);
  assert.deepEqual(
    gates.efficiencyImprovement.anyOf.map((entry) => entry.metric),
    ['unnecessaryActionCount', 'totalTokens', 'latencyMs'],
  );
});

test('prompt comparison aggregation boundary counts retries and incomplete attempts instead of dropping them', () => {
  const attempts = [
    { run: 'baseline-1', attempt: 1, status: 'completed' },
    { run: 'baseline-2', attempt: 1, status: 'incomplete' },
    { run: 'candidate-1', attempt: 1, status: 'failed' },
    { run: 'candidate-1', attempt: 2, status: 'completed' },
    { run: 'candidate-2', attempt: 1, status: 'completed' },
  ] as const;

  const summary = {
    providerCallCount: attempts.length,
    retryCount: attempts.filter((entry) => entry.attempt > 1).length,
    incompleteAttemptCount: attempts.filter((entry) => entry.status === 'incomplete').length,
    failedAttemptCount: attempts.filter((entry) => entry.status === 'failed').length,
    completedAttemptCount: attempts.filter((entry) => entry.status === 'completed').length,
    distinctScheduledRuns: new Set(attempts.map((entry) => entry.run)).size,
  };

  assert.deepEqual(summary, {
    providerCallCount: 5,
    retryCount: 1,
    incompleteAttemptCount: 1,
    failedAttemptCount: 1,
    completedAttemptCount: 3,
    distinctScheduledRuns: 4,
  });
  assert.ok(summary.providerCallCount <= corpus.promptComparison.execution.maxProviderCallsPerCase);
});

test('every case declares risk, route, source, and evidence and resolves proof route cleanly', () => {
  for (const c of corpus.cases) {
    assert.match(c.id, /^KRN-EVAL-\d{3}$/);
    assert.ok(['T0', 'T1', 'T2', 'T3'].includes(c.riskTier));
    assert.ok(c.expectedRoute.length >= 2);
    assert.ok(c.requiredEvidence.length);

    const proofInput = {
      requestedTier: c.riskTier,
      filesChanged: c.filesChanged || 1,
      surfaces: c.surfaces || [],
    };
    const proofRoute = resolveProofRoute(proofInput);
    assert.ok(['T0', 'T1', 'T2', 'T3'].includes(proofRoute.proofTier));
    assert.ok(['E0', 'E1', 'E2'].includes(proofRoute.evidenceTier));
    assert.ok(Array.isArray(proofRoute.requiredChecks));
  }
});

test('eval corpus executes route and evidence assertions for every case', () => {
  for (const c of corpus.cases) {
    const activeTrack = c.id === 'KRN-EVAL-003' ? 'relay' : 'kernel';
    const routed = routeTask(
      {
        taskClass: c.taskClass,
        riskTier: c.riskTier,
        objective: c.objective,
        surfaces: c.surfaces || [],
      },
      { projectRoot: evalProjects[activeTrack] },
    );
    if (activeTrack === 'relay') {
      assert.equal(routed.status, 'wrong_harness');
      assert.ok(c.requiredEvidence.includes('wrong-harness-receipt'));
      continue;
    }
    assert.equal(routed.status, 'ready');
    assert.deepEqual(routed.route, c.expectedRoute);
    const evidence = buildEvidencePack({
      objective: c.objective,
      proofTier: c.riskTier,
      sliceCount: c.taskClass === 'long-running' ? 2 : 1,
      completionDecision: 'blocked',
      checks: [{ evidenceRef: `evidence://${c.id}`, status: 'passed' }],
    });
    const actualEvidence = new Set(['route-receipt', 'verification-result']);
    if (evidence.tier === 'E2') actualEvidence.add('release-evidence');
    for (const required of c.requiredEvidence) assert.ok(actualEvidence.has(required));
  }
});
