import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveKernelCapabilities, KernelCapabilityError } from '../src/kernel/capability-resolver.js';
import { GUIDANCE_BUDGET, modelVisibleGuidanceCount } from '../src/kernel/capability-guidance.js';
import { routeTask } from '../src/kernel/route.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const kernelProject = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-capability-route-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
  return root;
};

test('T0 analysis does not activate mutation, review, debugging, or verification capabilities', () => {
  const decision = resolveKernelCapabilities({ taskClass: 'analysis', riskTier: 'T0', sourceMutation: false });
  assert.deepEqual(decision.selected, []);
  assert.equal(decision.revision, 'kernel-capability-conditions.v1');
});

test('behavior-changing bug selects diagnosis, minimal change, and verification in stable order without a TDD mandate', () => {
  const decision = resolveKernelCapabilities({ taskClass: 'bug', riskTier: 'T1', behaviorChanging: true });
  assert.deepEqual(decision.selected.map((entry) => entry.id), [
    'kernel-minimal-correct-change',
    'kernel-diagnosing-bugs',
    'kernel-review-standards',
    'kernel-verification-before-completion',
  ]);
  // The TDD signal stays internal; it never reaches the model as a process mandate.
  assert.ok(decision.internalSelected.some((entry) => entry.id === 'kernel-test-driven-development'));
  assert.ok(decision.compacted.some((entry) => entry.id === 'kernel-test-driven-development' && entry.reason === 'superseded_by_focused_test_guidance'));
});

test('behavior change emits a single test guidance only when a test surface exists', () => {
  const noSurface = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T1', behaviorChanging: true });
  assert.deepEqual(noSurface.selected.filter((entry) => entry.id.includes('test')).map((entry) => entry.id), []);
  const withSurface = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T1', behaviorChanging: true, testSurfaceAvailable: true });
  const testGuidance = withSurface.selected.filter((entry) => entry.id.includes('test'));
  assert.deepEqual(testGuidance.map((entry) => entry.id), ['kernel-focused-test-guidance']);
  assert.ok(testGuidance[0].guidance);
  assert.match(testGuidance[0].guidance, /focused regression test/);
  assert.doesNotMatch(testGuidance[0].guidance, /failing test/);
});

test('debug guidance is one diagnosis line and escalates to root-cause analysis only on repeated failure', () => {
  const first = resolveKernelCapabilities({ taskClass: 'bug', riskTier: 'T1', behaviorChanging: true });
  const firstDebug = first.selected.filter((entry) => ['kernel-diagnosing-bugs', 'kernel-systematic-debugging'].includes(entry.id));
  assert.deepEqual(firstDebug.map((entry) => entry.id), ['kernel-diagnosing-bugs']);
  assert.equal(firstDebug[0].guidance, 'Identify the failure boundary before making the fix.');

  const repeated = resolveKernelCapabilities({ taskClass: 'bug', riskTier: 'T1', behaviorChanging: true, repeatedFailure: true });
  const repeatedDebug = repeated.selected.filter((entry) => ['kernel-diagnosing-bugs', 'kernel-systematic-debugging'].includes(entry.id));
  assert.deepEqual(repeatedDebug.map((entry) => entry.id), ['kernel-systematic-debugging']);
  assert.ok(repeated.compacted.some((entry) => entry.id === 'kernel-diagnosing-bugs' && entry.reason === 'superseded_by_systematic_debugging'));

  const analysis = resolveKernelCapabilities({ taskClass: 'analysis', riskTier: 'T0', sourceMutation: false });
  assert.deepEqual(analysis.selected.filter((entry) => entry.id.includes('debug') || entry.id.includes('diagnos')), []);
});

test('spec, standards, and complexity review conditions compile into one review guidance with aspects', () => {
  const t1 = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T1', behaviorChanging: true });
  const t1Review = t1.selected.filter((entry) => entry.id.startsWith('kernel-review-'));
  assert.equal(t1Review.length, 1);
  assert.deepEqual(t1Review[0].aspects, { contract: false, implementation: true, complexity: false, security: false });
  assert.equal(t1Review[0].guidance, 'Review the changed implementation risks relevant to this work.');

  const t2 = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T2', behaviorChanging: true, publicContract: true });
  const t2Review = t2.selected.filter((entry) => entry.id.startsWith('kernel-review-'));
  assert.equal(t2Review.length, 1);
  assert.equal(t2Review[0].guidance, 'Review the changed contract and implementation risks relevant to this work.');

  const complex = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T2', behaviorChanging: true, publicContract: true, complex: true, newDependency: true });
  const complexReview = complex.selected.filter((entry) => entry.id.startsWith('kernel-review-'));
  assert.equal(complexReview.length, 1);
  assert.equal(complexReview[0].guidance, 'Review the changed contract, implementation risks, and unnecessary complexity relevant to this work.');
  assert.deepEqual(complexReview[0].aspects, { contract: true, implementation: true, complexity: true, security: false });
  // Internal review conditions are preserved for policy use.
  assert.deepEqual(
    complex.internalSelected.filter((entry) => entry.id.startsWith('kernel-review-')).map((entry) => entry.id),
    ['kernel-review-spec', 'kernel-review-standards', 'kernel-review-complexity'],
  );
});

test('simplification guidance needs a complexity signal, not a plain behavior change', () => {
  const plain = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T1', behaviorChanging: true, filesChanged: 4 });
  assert.equal(plain.selected.some((entry) => entry.id === 'kernel-simplification-check'), false);
  for (const signal of [{ newAbstraction: true }, { newDependency: true }, { complex: true }]) {
    const decision = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T1', behaviorChanging: true, ...signal });
    const entry = decision.selected.find((item) => item.id === 'kernel-simplification-check');
    assert.ok(entry, `expected simplification guidance for ${JSON.stringify(signal)}`);
    assert.equal(entry.guidance, 'Remove unnecessary abstraction or scope expansion introduced by this change.');
  }
  const manyFilesOnly = resolveKernelCapabilities({ taskClass: 'feature', riskTier: 'T1', behaviorChanging: true, filesChanged: 12 });
  assert.equal(manyFilesOnly.selected.some((entry) => entry.id === 'kernel-simplification-check'), false);
});

test('trust boundary capabilities stay active and are excluded from the instruction budget', () => {
  const secure = resolveKernelCapabilities({
    taskClass: 'feature',
    riskTier: 'T3',
    behaviorChanging: true,
    securityBoundary: true,
    objective: 'harden authentication token handling',
  });
  const ids = new Set(secure.selected.map((entry) => entry.id));
  assert.ok(ids.has('kernel-security-review-policy'));
  assert.ok(ids.has('kernel-verification-before-completion'));
  const review = secure.selected.find((entry) => entry.id.startsWith('kernel-review-'));
  assert.ok(review);
  assert.ok(review.aspects);
  assert.equal(review.aspects.security, true);

  const browser = resolveKernelCapabilities({
    taskClass: 'ui',
    riskTier: 'T2',
    behaviorChanging: true,
    browserProof: true,
    objective: 'login page must persist the session after reload',
    changedPaths: ['src/Login.tsx'],
    acceptance: ['user can log in and the session persists after reload'],
  });
  assert.ok(browser.selected.some((entry) => entry.id === 'kernel-browser-proof-adapter'));
});

test('model-visible guidance stays inside the instruction budget without duplicate-intent pairs', () => {
  const scenarios = [
    { name: 'simple', budget: GUIDANCE_BUDGET.simple, task: { taskClass: 'refactor', riskTier: 'T0', filesChanged: 1 } },
    { name: 'behaviorChange', budget: GUIDANCE_BUDGET.behaviorChange, task: { taskClass: 'feature', riskTier: 'T1', behaviorChanging: true, testSurfaceAvailable: true } },
    {
      name: 'complex',
      budget: GUIDANCE_BUDGET.complex,
      task: { taskClass: 'feature', riskTier: 'T2', behaviorChanging: true, testSurfaceAvailable: true, complex: true, newDependency: true, filesChanged: 12 },
    },
  ];
  for (const scenario of scenarios) {
    const decision = resolveKernelCapabilities(scenario.task);
    const ids = decision.selected.map((entry) => entry.id);
    assert.ok(
      modelVisibleGuidanceCount(decision.selected) <= scenario.budget,
      `${scenario.name} exceeded guidance budget: ${ids.join(', ')}`,
    );
    assert.equal(ids.includes('kernel-test-driven-development'), false);
    assert.ok(ids.filter((id) => id.startsWith('kernel-review-')).length <= 1);
    assert.ok(!(ids.includes('kernel-diagnosing-bugs') && ids.includes('kernel-systematic-debugging')));
    assert.equal(new Set(decision.selected.map((entry) => entry.guidance)).size, ids.length);
  }
});

test('complex ambiguous work selects domain and slicing capabilities and records reasons', () => {
  const project = { taskClass: 'long-running', complex: true, filesChanged: 12, ambiguityChangesOutcome: true, riskTier: 'T2', behaviorChanging: true };
  const decision = resolveKernelCapabilities(project);
  const ids = new Set(decision.selected.map((entry) => entry.id));
  for (const expected of ['kernel-domain-modeling', 'kernel-tracer-slicing']) assert.ok(ids.has(expected));
  const internalIds = new Set(decision.internalSelected.map((entry) => entry.id));
  for (const expected of ['kernel-review-spec', 'kernel-review-complexity']) assert.ok(internalIds.has(expected));
  assert.ok(decision.selected.every((entry) => entry.guidance && entry.activationCondition));
});

test('unknown caller capability is typed rejected and known forced-off capability is ignored with reason', async () => {
  assert.throws(() => resolveKernelCapabilities({ taskClass: 'analysis', capabilities: ['not-a-capability'] }), (error) => error instanceof KernelCapabilityError && error.code === 'kernel_capability_unknown');
  const decision = resolveKernelCapabilities({ taskClass: 'analysis', capabilities: ['kernel-diagnosing-bugs'] });
  assert.deepEqual(decision.ignoredRequested, [{ id: 'kernel-diagnosing-bugs', reason: 'caller_forced_condition_not_met' }]);
  const root = await kernelProject();
  const routed = routeTask({ taskClass: 'analysis', riskTier: 'T0', sourceMutation: false }, { projectRoot: root });
  assert.ok(routed.capabilityDecision);
  assert.equal(routed.capabilityDecision.revision, 'kernel-capability-conditions.v1');
  assert.deepEqual(routed.capabilities, []);
});
