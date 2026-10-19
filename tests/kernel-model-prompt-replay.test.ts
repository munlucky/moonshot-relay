import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import {
  captureModelPromptReplayAttempt,
  compareModelPromptReplay,
  dispatchModelPromptReplayAttempt,
  materializeModelPromptReplayArm,
} from '../src/host-tooling/kernel-eval/model-prompt-replay.js';
import { buildModelVisiblePromptView } from '../src/host/kernel/model-capsule-view.js';

const corpus = JSON.parse(await readFile(new URL('./fixtures/kernel-eval/corpus.json', import.meta.url), 'utf8'));
const protocol = corpus.promptComparison;
const cases = protocol.cases.map((entry: { id: string }) => entry.id);

const evaluation = (overrides: Record<string, unknown> = {}) => ({
  taskSuccess: true,
  acceptanceSatisfied: true,
  criticalAuthorityViolationCount: 0,
  scopeViolationCount: 0,
  hardcodedSolutionCount: 0,
  fallbackAbstractionGrowthCount: 0,
  regressionCount: 0,
  reworkCount: 0,
  unnecessaryToolCalls: 1,
  unnecessarySubagentCalls: 0,
  unnecessaryClarificationBeforeAction: 0,
  verificationDuplicationCount: 0,
  ...overrides,
});

const receipt = (overrides: Record<string, unknown> = {}) => ({
  hostSurface: 'codex',
  requestedModel: 'gpt-5.6-luna',
  resolvedModel: 'gpt-5.6-luna',
  observedModel: 'gpt-5.6-luna',
  requestedEffort: 'max',
  resolvedEffort: 'max',
  observedEffort: 'max',
  executionProfileRevision: 'host-execution-profile.v1:sha256:' + 'a'.repeat(64),
  promptPrefixDigest: 'sha256:' + 'b'.repeat(64),
  enforcementStatus: 'enforced',
  inputTokens: 100,
  outputTokens: 20,
  wallClockMs: 1000,
  ...overrides,
});

const attempts = ({
  candidateReceipt = {},
  candidateEvaluation = {},
  baselinePromptMeasurement = {},
  candidatePromptMeasurement = {},
}: {
  candidateReceipt?: Record<string, unknown>;
  candidateEvaluation?: Record<string, unknown>;
  baselinePromptMeasurement?: Record<string, unknown>;
  candidatePromptMeasurement?: Record<string, unknown>;
} = {}) => cases.flatMap((caseId: string) => {
  const repetitions = { baseline: 0, candidate: 0 };
  return protocol.execution.armOrder.map((arm: 'baseline' | 'candidate', order: number) => {
    repetitions[arm] += 1;
    return captureModelPromptReplayAttempt({
      caseId,
      arm,
      order,
      repetition: repetitions[arm],
      hostResult: {
        receipt: receipt(arm === 'candidate' ? candidateReceipt : {}),
        promptMeasurement: arm === 'candidate'
          ? candidatePromptMeasurement
          : baselinePromptMeasurement,
      },
      evaluation: evaluation(arm === 'candidate' ? candidateEvaluation : {}),
    });
  });
});

test('one replay attempt uses the real Host dispatcher and captures its receipt', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'model-prompt-replay-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'model-prompt-replay-project-'));
  try {
    spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'replay-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }));
    const controlPlane = await createKernelControlPlane({ runtimeHome, projectRoot });
    try {
      await controlPlane.startRun({ runId: 'replay-run', objective: 'replay fixture' });
      const adapter = createClaudeAdapter({
        launch: async ({ invocation }) => {
          assert.ok(invocation && typeof invocation === 'object');
          const resolved = invocation as Record<string, unknown>;
          return {
            resolvedModel: resolved.model,
            resolvedEffort: resolved.effort,
            observedSessionConfig: { model: resolved.model, effort: resolved.effort },
            sessionId: 'replay-session',
            wallClockMs: 50,
            inputTokens: 10,
            outputTokens: 5,
          };
        },
      });
      const result = await dispatchModelPromptReplayAttempt({
        caseId: 'PROMPT-EVAL-001',
        arm: 'baseline',
        order: 0,
        repetition: 1,
        dispatchInput: {
          controlPlane,
          runId: 'replay-run',
          adapter,
          registry: createModelRegistry({
            surface: 'claude',
            env: {
              MOON_RELAY_KERNEL_MODEL_FRONTIER: 'frontier',
              MOON_RELAY_KERNEL_MODEL_VALUE: 'value',
            },
          }),
          actionContext: { executionMode: 'native-subagent', delegationRequested: true },
        },
        evaluation: evaluation(),
      });
      assert.equal(result.receipt?.enforcementStatus, 'enforced');
      assert.match(String(result.receipt?.executionProfileRevision), /^host-execution-profile\.v1:sha256:[a-f0-9]{64}$/);
      assert.match(String(result.receipt?.promptPrefixDigest), /^sha256:[a-f0-9]{64}$/);
      assert.ok(result.promptMeasurement);
      assert.ok(Number(result.promptMeasurement.providerMessageBytes) > 0);
      assert.match(String(result.promptMeasurement.providerMessageDigest), /^sha256:[a-f0-9]{64}$/);
      assert.ok(Array.isArray(result.promptMeasurement.segments));
    } finally {
      await controlPlane.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('prompt-only replay arms materialize distinct provider messages over the same six-field payload', () => {
  const prompt = buildModelVisiblePromptView({
    modelInput: {
      objective: 'Change the bounded target.',
      acceptance: ['target is correct'],
      constraints: ['stay in scope'],
      action: {
        type: 'implement',
        guidance: 'use the existing helper',
        step: { objective: 'edit target', allowedPaths: ['src/target.ts'], forbiddenPaths: [] },
        obligations: [{ obligationId: 'target-check' }],
      },
    },
  });
  const baseline = materializeModelPromptReplayArm({ arm: 'baseline', prompt });
  const candidate = materializeModelPromptReplayArm({ arm: 'candidate', prompt });
  const marker = 'MODEL VISIBLE CONTEXT\n';

  assert.notEqual(candidate.providerMessageDigest, baseline.providerMessageDigest);
  assert.ok(candidate.providerMessageBytes < baseline.providerMessageBytes);
  assert.deepEqual(
    JSON.parse(candidate.message.split(marker)[1]),
    JSON.parse(baseline.message.split(marker)[1]),
  );
});

test('prompt replay can ablate guidance only on the candidate arm without changing scope or objective', () => {
  const prompt = buildModelVisiblePromptView({
    modelInput: {
      objective: 'Change the bounded target.',
      acceptance: ['target is correct'],
      constraints: ['stay in scope'],
      action: {
        type: 'implement',
        guidance: 'Prefer the existing helper if it fits.',
        step: {
          objective: 'Edit target.',
          allowedPaths: ['src/target.ts'],
          forbiddenPaths: ['src/other.ts'],
          expectedOutputs: ['updated target'],
        },
        obligations: [{ obligationId: 'target-check' }],
      },
    },
  });
  const candidate = materializeModelPromptReplayArm({
    arm: 'candidate',
    prompt,
    ablateGuidance: true,
  });
  const baseline = materializeModelPromptReplayArm({ arm: 'baseline', prompt });
  const marker = 'MODEL VISIBLE CONTEXT\n';
  const candidatePayload = JSON.parse(candidate.message.split(marker)[1]);
  const baselinePayload = JSON.parse(baseline.message.split(marker)[1]);

  assert.equal(candidate.guidanceAblated, true);
  assert.equal(candidatePayload.currentWork.guidance, '');
  assert.equal(baselinePayload.currentWork.guidance, 'Prefer the existing helper if it fits.');
  assert.equal(candidatePayload.currentWork.objective, baselinePayload.currentWork.objective);
  assert.deepEqual(candidatePayload.currentWork.allowedPaths, baselinePayload.currentWork.allowedPaths);
  assert.deepEqual(candidatePayload.currentWork.forbiddenPaths, baselinePayload.currentWork.forbiddenPaths);
  assert.deepEqual(candidatePayload.acceptance, baselinePayload.acceptance);
  assert.deepEqual(candidatePayload.requiredEvidence, baselinePayload.requiredEvidence);
  assert.ok(candidate.providerMessageBytes < baseline.providerMessageBytes);
});

test('prompt replay reports guidance ablation only when the candidate actually removes guidance', () => {
  const prompt = buildModelVisiblePromptView({
    modelInput: {
      objective: '',
      action: {
        type: 'implement',
        guidance: 'Only guidance is available.',
      },
    },
  });
  const candidate = materializeModelPromptReplayArm({
    arm: 'candidate',
    prompt,
    ablateGuidance: true,
  });
  assert.equal(candidate.guidanceAblated, false);
  const payload = JSON.parse(candidate.message.split('MODEL VISIBLE CONTEXT\n')[1]);
  assert.equal(payload.currentWork.guidance, 'Only guidance is available.');
});

test('missing or unobserved Host identity makes a comparison not ready', () => {
  const report = compareModelPromptReplay({
    protocol,
    attempts: attempts({
      candidateReceipt: {
        enforcementStatus: 'advisory',
        observedModel: null,
        observedEffort: null,
      },
    }),
    experiment: { allowedDifferences: ['effort'] },
  });
  assert.equal(report.status, 'not-ready');
  assert.equal(report.decision, 'keep-baseline');
  assert.ok(report.issues.some((issue: string) => issue.includes('host-model-enforcement-not-proven')));
});

test('unexpected prompt or execution-profile drift is rejected before scoring', () => {
  const report = compareModelPromptReplay({
    protocol,
    attempts: attempts({
      candidateReceipt: {
        requestedEffort: 'high',
        resolvedEffort: 'high',
        observedEffort: 'high',
        promptPrefixDigest: 'sha256:' + 'c'.repeat(64),
      },
    }),
    experiment: { allowedDifferences: ['effort'] },
  });
  assert.equal(report.status, 'not-ready');
  assert.ok(report.issues.some((issue: string) => issue.includes('prompt-prefix-drift')));
});

test('prompt-only replay requires an explicit provider-message difference and measured digests', () => {
  const baselineDigest = 'sha256:' + '1'.repeat(64);
  const candidateDigest = 'sha256:' + '2'.repeat(64);
  const replayAttempts = attempts({
    baselinePromptMeasurement: { providerMessageDigest: baselineDigest },
    candidatePromptMeasurement: { providerMessageDigest: candidateDigest },
  });

  const rejected = compareModelPromptReplay({ protocol, attempts: replayAttempts });
  assert.equal(rejected.status, 'not-ready');
  assert.ok(rejected.issues.some((issue: string) => issue.endsWith(':provider-message-drift')));

  const allowed = compareModelPromptReplay({
    protocol,
    attempts: replayAttempts,
    experiment: { allowedDifferences: ['providerMessageDigest'] },
  });
  assert.equal(allowed.issues.length, 0);
  assert.notEqual(allowed.status, 'not-ready');
});

test('prompt-only replay fails closed when the declared provider-message digest is missing', () => {
  const result = compareModelPromptReplay({
    protocol,
    attempts: attempts(),
    experiment: { allowedDifferences: ['providerMessageDigest'] },
  });
  assert.equal(result.status, 'not-ready');
  assert.ok(result.issues.some((issue: string) => issue.endsWith(':provider-message-digest-missing')));
});

test('quality regression stops evaluation before rework and efficiency', () => {
  const report = compareModelPromptReplay({
    protocol,
    attempts: attempts({
      candidateReceipt: {
        requestedEffort: 'high',
        resolvedEffort: 'high',
        observedEffort: 'high',
      },
      candidateEvaluation: { taskSuccess: false, unnecessaryToolCalls: 0 },
    }),
    experiment: { allowedDifferences: ['effort'] },
  });
  assert.equal(report.status, 'rejected-quality');
  assert.equal(report.qualityGate, 'failed');
  assert.equal(report.reworkGate, 'not-evaluated');
  assert.equal(report.efficiencyGate, 'not-evaluated');
});

test('rework regression stops evaluation before time or token wins', () => {
  const report = compareModelPromptReplay({
    protocol,
    attempts: attempts({
      candidateReceipt: {
        requestedEffort: 'high',
        resolvedEffort: 'high',
        observedEffort: 'high',
        inputTokens: 50,
        outputTokens: 10,
        wallClockMs: 400,
      },
      candidateEvaluation: { reworkCount: 1, unnecessaryToolCalls: 0 },
    }),
    experiment: { allowedDifferences: ['effort'] },
  });
  assert.equal(report.status, 'rejected-rework');
  assert.equal(report.qualityGate, 'passed');
  assert.equal(report.reworkGate, 'failed');
  assert.equal(report.efficiencyGate, 'not-evaluated');
});

test('a candidate becomes eligible only after quality and rework pass with measured efficiency gain', () => {
  const report = compareModelPromptReplay({
    protocol,
    attempts: attempts({
      candidateReceipt: {
        requestedEffort: 'high',
        resolvedEffort: 'high',
        observedEffort: 'high',
        inputTokens: 80,
        outputTokens: 10,
        wallClockMs: 800,
      },
      candidateEvaluation: { unnecessaryToolCalls: 0 },
    }),
    experiment: { allowedDifferences: ['effort'] },
  });
  assert.equal(report.status, 'eligible');
  assert.equal(report.decision, 'candidate-eligible');
  assert.equal(report.qualityGate, 'passed');
  assert.equal(report.reworkGate, 'passed');
  assert.equal(report.efficiencyGate, 'passed');
});

test('equal quality without a proven efficiency gain keeps the baseline', () => {
  const report = compareModelPromptReplay({
    protocol,
    attempts: attempts({
      candidateReceipt: {
        requestedEffort: 'high',
        resolvedEffort: 'high',
        observedEffort: 'high',
      },
    }),
    experiment: { allowedDifferences: ['effort'] },
  });
  assert.equal(report.status, 'insufficient-efficiency-evidence');
  assert.equal(report.decision, 'keep-baseline');
});

test('retries and incomplete attempts remain in the comparison instead of being dropped', () => {
  const replayAttempts = attempts();
  const baselineIndex = replayAttempts.findIndex(
    (entry: { caseId: string; arm: string; order: number }) => (
      entry.caseId === 'PROMPT-EVAL-001' && entry.arm === 'baseline' && entry.order === 0
    ),
  );
  const candidateIndex = replayAttempts.findIndex(
    (entry: { caseId: string; arm: string; order: number }) => (
      entry.caseId === 'PROMPT-EVAL-001' && entry.arm === 'candidate' && entry.order === 1
    ),
  );
  assert.ok(baselineIndex >= 0);
  assert.ok(candidateIndex >= 0);

  replayAttempts[baselineIndex] = captureModelPromptReplayAttempt({
    caseId: 'PROMPT-EVAL-001',
    arm: 'baseline',
    order: 0,
    repetition: 1,
    attempt: 1,
    status: 'incomplete',
    hostResult: { receipt: receipt() },
    evaluation: evaluation(),
  });
  replayAttempts[candidateIndex] = captureModelPromptReplayAttempt({
    caseId: 'PROMPT-EVAL-001',
    arm: 'candidate',
    order: 1,
    repetition: 1,
    attempt: 1,
    status: 'failed',
    hostResult: { receipt: receipt() },
    evaluation: evaluation(),
  });
  replayAttempts.splice(candidateIndex + 1, 0, captureModelPromptReplayAttempt({
    caseId: 'PROMPT-EVAL-001',
    arm: 'candidate',
    order: 1,
    repetition: 1,
    attempt: 2,
    status: 'completed',
    hostResult: { receipt: receipt() },
    evaluation: evaluation(),
  }));

  const report = compareModelPromptReplay({ protocol, attempts: replayAttempts });
  assert.notEqual(report.status, 'not-ready');
  assert.equal(report.baseline.incompleteAttemptCount, 1);
  assert.equal(report.candidate.failedAttemptCount, 1);
  assert.equal(report.candidate.retryCount, 1);
  assert.equal(report.candidate.attempts, protocol.cases.length * 2 + 1);
});

test('retry attempts beyond the C01 budget fail closed', () => {
  const replayAttempts = attempts();
  const candidateIndex = replayAttempts.findIndex(
    (entry: { caseId: string; arm: string; order: number }) => (
      entry.caseId === 'PROMPT-EVAL-001' && entry.arm === 'candidate' && entry.order === 1
    ),
  );
  assert.ok(candidateIndex >= 0);
  replayAttempts.splice(candidateIndex + 1, 0, captureModelPromptReplayAttempt({
    caseId: 'PROMPT-EVAL-001',
    arm: 'candidate',
    order: 1,
    repetition: 1,
    attempt: 3,
    status: 'completed',
    hostResult: { receipt: receipt() },
    evaluation: evaluation(),
  }));

  const report = compareModelPromptReplay({ protocol, attempts: replayAttempts });
  assert.equal(report.status, 'not-ready');
  assert.ok(report.issues.some((issue: string) => issue.includes('retry-budget-exceeded')));
  assert.ok(report.issues.some((issue: string) => issue.includes('attempt-sequence-invalid')));
});

test('the fixed C01 ABBA coverage is required exactly', () => {
  const replayAttempts = attempts();
  const report = compareModelPromptReplay({
    protocol,
    attempts: replayAttempts.slice(1),
  });
  assert.equal(report.status, 'not-ready');
  assert.ok(report.issues.includes('attempt-coverage-or-order-mismatch'));
});
