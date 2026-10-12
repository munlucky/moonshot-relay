import { assertTestArray, assertTestNumber, assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { compileRunObligations, assertVerificationSupport } from '../src/kernel/run/obligation-compiler.js';
import { deriveVerificationSettlementScope } from '../src/contracts/verification-settlement.js';
import { mergeContractRevisionWithBindings, normalizeTaskContract } from '../src/kernel/task/task-contract.js';
import { discoverProjectCommands, classifyCommandName } from '../src/contracts/command-catalog.js';
import { observeProjectCommandDeclarations } from '../src/host/kernel/proof/project-command-observation.js';
import { createHostProcessObservation } from '../src/host/kernel/process-observation.js';

const projectCommands = (projectRoot: string) => discoverProjectCommands({
  observation: observeProjectCommandDeclarations({ projectRoot }),
});

const SCRIPTS = {
  'test:ok': 'node -e "process.exit(0)"',
  'test:fail': 'node -e "process.exit(1)"',
  lint: 'node -e "process.exit(0)"',
  noop: 'node -e "process.exit(0)"',
};

const setup = async ({ scripts = SCRIPTS }: { scripts?: Record<string, string> } = {}) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-bind-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-bind-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'bind-fixture', version: '0.0.1', scripts }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const mutate = (projectRoot: string, value: string | number) => writeFile(path.join(projectRoot, 'app.mjs'), `export const v = ${value};\n`);


test('verification settlement scope stays derived: scoped/acceptance proof is focused and broad policy is goal', () => {
  const compatibilityInput6 = {
    obligationId: 'step-test',
    evidenceClass: 'hard',
    sourceType: 'caller',
    metadata: { scope: ['src/auth/**'] },
  };
    assert.equal(deriveVerificationSettlementScope(compatibilityInput6), 'focused');
  const compatibilityInput7 = {
    obligationId: 'acceptance-ac-1',
    evidenceClass: 'hard',
    sourceType: 'evidence-plan',
    acceptanceIds: ['AC-1'],
  };
    assert.equal(deriveVerificationSettlementScope(compatibilityInput7), 'focused');
  const compatibilityInput8 = {
    obligationId: 'unit-test',
    evidenceClass: 'hard',
    sourceType: 'proof-policy',
  };
    assert.equal(deriveVerificationSettlementScope(compatibilityInput8), 'goal');
  const compatibilityInput9 = {
    obligationId: 'unknown-hard',
    evidenceClass: 'hard',
    sourceType: 'caller',
  };
    assert.equal(deriveVerificationSettlementScope(compatibilityInput9), 'goal');
  const compatibilityInput10 = {
    obligationId: 'global-project-rule',
    evidenceClass: 'hard',
    sourceType: 'knowledge',
  };
    assert.equal(deriveVerificationSettlementScope(compatibilityInput10), 'goal', 'unscoped project knowledge remains conservative goal proof');
});

test('required verification timeout remains an obligation contract value', async () => {
  const fixture = await setup();
  try {
    const obligations = compileRunObligations({
      projectRoot: fixture.projectRoot,
      commands: projectCommands(fixture.projectRoot),
      requiredChecks: [],
      contract: {
        requiredVerifications: [{ obligationId: 'long-goal', commandRef: 'test:ok', timeoutMs: 600000 }],
      },
    });
    assert.equal(assertTestPresent(obligations[0].metadata).timeoutMs, 600000);
  } finally {
    await cleanup(fixture);
  }
});

test('legacy required-verification statements recover their Kernel command binding', async () => {
  const fixture = await setup();
  try {
    const obligations = compileRunObligations({
      projectRoot: fixture.projectRoot,
      commands: projectCommands(fixture.projectRoot),
      requiredChecks: [],
      contract: {},
      knowledgeRecords: [{
        id: 'kn-legacy-test-kernel',
        type: 'required_verification',
        statement: 'Regression verification executed: test:ok',
        scope: ['app.mjs'],
        status: 'committed',
      }],
      changedPaths: ['app.mjs'],
    });
    assert.deepEqual(obligations[0].allowedCommandRefs, ['test:ok']);
  } finally {
    await cleanup(fixture);
  }
});

test('P1-4: project commands are discovered per ecosystem and classified semantically', async () => {
  const fixture = await setup();
  try {
    await writeFile(path.join(fixture.projectRoot, 'Makefile'), 'e2e:\n\t@echo ok\nbuild:\n\t@echo ok\n');
    await writeFile(path.join(fixture.projectRoot, 'go.mod'), 'module example.com/x\n');
    const commands = projectCommands(fixture.projectRoot);
    const byRef = Object.fromEntries(commands.map((command) => [command.commandRef, command]));

    assert.equal(byRef['test:ok'].commandClass, 'unit-test');
    assert.equal(byRef.lint.commandClass, 'static-analysis');
    // A script whose name carries no semantic meaning is a plain script and can
    // never stand in for a typed obligation.
    assert.equal(byRef.noop.commandClass, 'script');
    assert.equal(byRef['make:e2e'].commandClass, 'e2e');
    assert.equal(byRef['go:test'].commandClass, 'unit-test');
    assert.equal(byRef['go:vet'].commandClass, 'static-analysis');
    assert.equal(classifyCommandName('runtime:reproduce'), 'runtime-reproduction');
    assert.equal(classifyCommandName('runtime:observe'), 'runtime-observation');
    assert.equal(classifyCommandName('deploy'), 'deployment');
    assert.equal(classifyCommandName('post-deploy:observe'), 'post-deployment-observation');
  } finally {
    await cleanup(fixture);
  }
});

test('P0: an explicit evidence plan with no usable project command is compiled with rejected reason', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const started = await cp.startRun({
      runId: 'r-unsupported-preflight',
      objective: 'observe production behavior',
      taskContract: {
        acceptance: [{
          acceptance: 'the deployed runtime is observed',
          evidencePlan: {
            class: 'hard',
            method: 'post-deployment-observation',
            commandRefs: ['observe:production'],
          },
        }],
      },
    });
    assert.equal(started.runId, 'r-unsupported-preflight');
    const obligations = cp.stateStore.getRunObligations('r-unsupported-preflight');
    assert.deepEqual(obligations[0].rejectedCommandRefs, [{
      commandRef: 'observe:production',
      reason: 'not-declared-by-project',
    }]);
    assert.equal(obligations[0].satisfiable, false);

    assert.throws(
      () => assertVerificationSupport(obligations, assertTestPresent(started.taskContract)),
      (error) => {
        assert.equal(assertTestRecord(error).code, 'unsupported-verification');
        assert.equal(assertTestRecord(error).nextAction, 'declare-project-verification-command');
        assert.deepEqual(assertTestRecord(assertTestArray(assertTestRecord(assertTestRecord(error).details).unsupported)[0]).rejectedCommandRefs, [{
          commandRef: 'observe:production',
          reason: 'not-declared-by-project',
        }]);
        return true;
      },
    );
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0: a tier-required hard obligation with no project command fails when verification support is required', async () => {
  const fixture = await setup({ scripts: { noop: 'node -e "process.exit(0)"' } });
  const cp = await createKernelControlPlane(fixture);
  try {
    const started = await cp.startRun({
      runId: 'r-unsupported-proof-policy',
      objective: 'change behavior without a test command',
      taskContract: { behaviorChanging: true, acceptance: ['the behavior changes safely'] },
    });
    assert.equal(started.runId, 'r-unsupported-proof-policy');
    const obligations = cp.stateStore.getRunObligations('r-unsupported-proof-policy');
    assert.throws(
      () => assertVerificationSupport(obligations, assertTestPresent(started.taskContract)),
      (error) => assertTestRecord(error).code === 'unsupported-verification'
        && assertTestArray(assertTestRecord(assertTestRecord(error).details).unsupported).some((item: unknown) => (
          assertTestRecord(item).obligationId === 'unit-test'
          && assertTestRecord(item).sourceType === 'proof-policy'
        )),
    );
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0: runtime and release evidence methods bind only to matching command classes', async () => {
  const compatibilityInput11 = {
    scripts: {
      ...SCRIPTS,
      'runtime:reproduce': 'node -e "process.exit(0)"',
      'runtime:observe': 'node -e "process.exit(0)"',
      deploy: 'node -e "process.exit(0)"',
      'post-deploy:observe': 'node -e "process.exit(0)"',
    },
  };
    const fixture = await setup(compatibilityInput11);
  try {
    const contract = normalizeTaskContract({
      acceptance: [
        { acceptance: 'reproduced', evidencePlan: { class: 'hard', method: 'runtime-reproduction', commandRefs: ['runtime:reproduce'] } },
        { acceptance: 'observed', evidencePlan: { class: 'hard', method: 'runtime-observation', commandRefs: ['runtime:observe'] } },
        { acceptance: 'deployed', evidencePlan: { class: 'hard', method: 'deployment', commandRefs: ['deploy'] } },
        { acceptance: 'resolved', evidencePlan: { class: 'hard', method: 'post-deployment-observation', commandRefs: ['post-deploy:observe'], outcome: 'resolved' } },
      ],
      completionPredicate: { requiredOutcomes: ['implemented', 'verified', 'deployed', 'observed', 'resolved'] },
    }, { objective: 'runtime incident' });
    const obligations = compileRunObligations({
      projectRoot: fixture.projectRoot,
      commands: projectCommands(fixture.projectRoot),
      requiredChecks: [],
      contract,
    });
    assert.deepEqual(obligations.map((item) => item.allowedCommandRefs), [
      ['runtime:reproduce'],
      ['runtime:observe'],
      ['deploy'],
      ['post-deploy:observe'],
    ]);
    assert.deepEqual(obligations.map((item) => assertTestPresent(item.metadata).outcome), [
      'verified',
      'observed',
      'deployed',
      'resolved',
    ]);
  } finally {
    await cleanup(fixture);
  }
});

test('P0: a required resolved outcome without resolution evidence fails completion preflight', async () => {
  const compatibilityInput12 = {
    scripts: { ...SCRIPTS, build: 'node -e "process.exit(0)"' },
  };
    const fixture = await setup(compatibilityInput12);
  const cp = await createKernelControlPlane(fixture);
  try {
    const started = await cp.startRun({
      runId: 'r-build-is-not-resolution',
      objective: 'resolve a runtime incident',
      taskContract: {
        completionPredicate: { requiredOutcomes: ['implemented', 'verified', 'resolved'] },
        acceptance: [{
          acceptance: 'the code builds',
          evidencePlan: { class: 'hard', method: 'build', commandRefs: ['build'] },
        }],
      },
    });
    assert.equal(started.runId, 'r-build-is-not-resolution');
    const obligations = cp.stateStore.getRunObligations('r-build-is-not-resolution');
    assert.throws(
      () => assertVerificationSupport(obligations, assertTestPresent(started.taskContract)),
      (error) => assertTestRecord(error).code === 'unsupported-verification'
        && assertTestArray(assertTestRecord(assertTestRecord(error).details).unsupported).some((item: unknown) => (
          assertTestRecord(item).outcome === 'resolved'
          && assertTestRecord(item).reason === 'required-outcome-has-no-bound-evidence-plan'
        )),
    );
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0: unknown completion outcomes fail closed instead of weakening the predicate', () => {
  assert.throws(
    () => normalizeTaskContract({
      completionPredicate: { requiredOutcomes: ['implemented', 'resovled'] },
    }, { objective: 'typo must not disappear' }),
    (error) => assertTestRecord(error).code === 'completion-predicate-invalid'
      && assertTestArray(assertTestRecord(assertTestRecord(error).details).invalidOutcomes).includes('resovled'),
  );
});

test('P0-2: an obligation is bound to the commands that can prove it', async () => {
  const fixture = await setup();
  try {
    const contract = normalizeTaskContract({ acceptance: ['works'] }, { objective: 'x' });
    const obligations = compileRunObligations({
      projectRoot: fixture.projectRoot,
      commands: projectCommands(fixture.projectRoot),
      requiredChecks: ['static-analysis', 'unit-test', 'security-review'],
      contract,
    });
    const byId = Object.fromEntries(obligations.map((obligation) => [obligation.obligationId, obligation]));

    assert.deepEqual(byId['unit-test'].allowedCommandRefs, ['test:ok', 'test:fail']);
    assert.equal(byId['unit-test'].evidenceClass, 'hard');
    assert.deepEqual(byId['static-analysis'].allowedCommandRefs, ['lint']);
    // security-review is a judgment obligation: no command can satisfy it.
    assert.equal(byId['security-review'].evidenceClass, 'judgment');
    assert.deepEqual(byId['security-review'].allowedCommandRefs, []);
    assert.equal(byId['security-review'].protected, true);
    // Every acceptance criterion is bound to at least one obligation.
    assert.ok(obligations.some((obligation) => obligation.acceptanceIds.includes('AC-1')));
  } finally {
    await cleanup(fixture);
  }
});

test('P0-2: a passing but unrelated command cannot be filed under a typed obligation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-forge', objective: 'x', taskContract: { riskTier: 'T2', behaviorChanging: true } });
    await mutate(fixture.projectRoot, 1);

    const forged = await cp.report('r-forge', {
      summary: 'claiming coverage',
      verifications: [{ obligationId: 'unit-test', commandRef: 'noop' }],
    });
    assert.equal(assertTestPresent(forged).status, 'evidence-rejected');
    assert.equal(assertTestArray(assertTestRecord(assertTestPresent(forged)).executed).length, 0, 'a rejected binding must not execute the command');
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(forged)).failures)[0]).errorSummary), /not bound to obligation "unit-test"/);
    assert.deepEqual(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(forged)).failures)[0]).allowedCommandRefs, ['test:ok', 'test:fail']);

    const honest = await cp.report('r-forge', {
      summary: 'real evidence',
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok' },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });
    assert.equal(assertTestPresent(honest).status, 'completed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-3: evidence classes are not substitutable in either direction', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-class', objective: 'x', taskContract: { riskTier: 'T3' } });
    await mutate(fixture.projectRoot, 1);

    // One real hard proof plus judgments for the rest — the substitution the
    // review described. static-analysis is executable, so a judgment for it
    // must not count.
    await cp.report('r-class', {
      summary: 'mixed evidence',
      implementerId: 'agent-1',
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok' }],
      judgments: [
        { obligationId: 'static-analysis', verdict: 'pass', reason: 'reviewed' },
        { obligationId: 'security-review', verdict: 'pass', reason: 'reviewed', reviewerId: 'reviewer-1', rationale: 'no auth surface' },
      ],
    });

    const completion = await cp.assessCompletion('r-class');
    const byId = Object.fromEntries(completion.obligationStatuses.map((entry) => [entry.obligationId, entry]));
    assert.equal(byId['unit-test'].satisfied, true, 'kernel-executed command satisfies a hard obligation');
    assert.equal(byId['static-analysis'].satisfied, false, 'a judgment must not satisfy an executable obligation');
    // K0: a self-asserted verdict no longer satisfies a protected judgment
    // obligation either — it needs a Review Receipt with a real reviewer
    // lineage. See tests/kernel-review-receipt.test.mjs.
    assert.equal(byId['security-review'].satisfied, false, 'a report-authored verdict cannot satisfy a protected judgment obligation');
    assert.deepEqual(byId['security-review'].reviewLineage, null, 'the rejected judgment is never recorded, so there is no lineage to inspect');
    assert.equal(completion.decision, 'blocked');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

// --- Codex review findings on 7dddf196 ------------------------------------

test('F1: an evidence plan cannot bind a command that proves nothing', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    // `noop` is a declared script, but its name carries no semantic claim, so
    // it cannot stand as the proof of a criterion planned as a test.
    // Progressive admission compiles this with rejected reason 'class-script-does-not-prove-unit-test'.
    await cp.startRun({
      runId: 'r-f1',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'login must be secure', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['noop'] } }],
      },
    });
    const obligationsF1 = cp.stateStore.getRunObligations('r-f1');
    assert.equal(obligationsF1[0].rejectedCommandRefs[0].reason, 'class-script-does-not-prove-unit-test');
    assert.equal(obligationsF1[0].satisfiable, false);
    await cp.abandonRun('r-f1');

    // A ref the project never declared is recorded as 'not-declared-by-project'.
    await cp.startRun({
      runId: 'r-f1b',
      objective: 'x',
      taskContract: { acceptance: [{ acceptance: 'y', evidencePlan: { class: 'hard', commandRefs: ['test:does-not-exist'] } }] },
    });
    const obligationsF1b = cp.stateStore.getRunObligations('r-f1b');
    assert.equal(obligationsF1b[0].rejectedCommandRefs[0].reason, 'not-declared-by-project');
    assert.equal(obligationsF1b[0].satisfiable, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('F1: an honest evidence plan still binds across the test family', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    // Classification is name-based, so a `test:*` script reads as unit-test
    // even when it is the integration test. The family match must accept it.
    await cp.startRun({
      runId: 'r-f1c',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'checkout works end to end', evidencePlan: { class: 'hard', method: 'integration-test', commandRefs: ['test:ok'] } }],
      },
    });
    const next = await cp.next('r-f1c');
    const planned = assertTestArray(assertTestRecord(assertTestRecord(next).action).obligations).find((entry: unknown) => assertTestString(assertTestRecord(entry).obligationId).startsWith('acceptance-'));
    assert.deepEqual(assertTestRecord(planned).allowedCommandRefs, ['test:ok']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-2: an explicit AC plan narrows a reused obligation to its named commands', async () => {
  const compatibilityInput13 = {
    scripts: {
      ...SCRIPTS,
      'test:a': 'node -e "process.exit(0)"',
      'test:b': 'node -e "process.exit(0)"',
    },
  };
    const fixture = await setup(compatibilityInput13);
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-plan-reuse',
      objective: 'x',
      taskContract: {
        acceptance: [{
          id: 'AC-1',
          acceptance: 'works',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:b'],
            obligationId: 'unit-test',
          },
        }],
      },
    });
    const bound = cp.stateStore.getRunObligation('r-plan-reuse', 'unit-test');
    assert.deepEqual(assertTestPresent(bound).allowedCommandRefs, ['test:b']);

    await mutate(fixture.projectRoot, 1);
    const unrelated = await cp.report('r-plan-reuse', {
      summary: 'unplanned command',
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:a', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(assertTestPresent(unrelated).status, 'evidence-rejected');
    assert.equal(assertTestArray(assertTestRecord(assertTestPresent(unrelated)).executed).length, 0, 'an unplanned but same-family command is rejected before execution');
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(unrelated)).failures)[0]).errorSummary), /not bound to obligation "unit-test"/);
    assert.deepEqual(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(unrelated)).failures)[0]).allowedCommandRefs, ['test:b']);

    const planned = await cp.report('r-plan-reuse', {
      summary: 'planned command',
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:b', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(planned)).executed)[0]).status, 'passed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-2: PROVE refresh preserves the highest-authority binding on a reused obligation', async () => {
  const compatibilityInput14 = {
    scripts: {
      ...SCRIPTS,
      'test:policy': 'node -e "process.exit(0)"',
    },
  };
    const fixture = await setup(compatibilityInput14);
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-refresh-authority',
      objective: 'preserve explicit authority during deferred refresh',
      taskContract: {
        acceptance: [{
          id: 'AC-1',
          acceptance: 'works',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:explicit'],
            obligationId: 'unit-test',
          },
        }],
      },
    });

    const before = cp.stateStore.getRunObligation('r-refresh-authority', 'unit-test');
    assert.deepEqual(assertTestPresent(before).allowedCommandRefs, []);
    assert.ok(assertTestPresent(assertTestPresent(before).metadata.commandCandidates).some((candidate) => candidate.sourceType === 'evidence-plan'));

    await writeFile(path.join(fixture.projectRoot, 'package.json'), JSON.stringify({
      name: 'kernel-fixture',
      version: '0.0.1',
      scripts: {
        'test:policy': 'node -e "process.exit(0)"',
        'test:explicit': 'node -e "process.exit(0)"',
      },
    }));
    await cp.transition('r-refresh-authority', 'EXECUTE');
    await cp.transition('r-refresh-authority', 'PROVE');

    const after = cp.stateStore.getRunObligation('r-refresh-authority', 'unit-test');
    assert.deepEqual(assertTestPresent(after).allowedCommandRefs, ['test:explicit']);
    assert.equal(assertTestPresent(after).satisfiable, true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-2: direct executeProof rejects an unbound command before running it', async () => {
  const compatibilityInput15 = {
    scripts: {
      ...SCRIPTS,
      'test:unbound': 'node -e "require(\'fs\').writeFileSync(\'unbound-proof-ran\', \'yes\')"',
    },
  };
    const fixture = await setup(compatibilityInput15);
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-direct-binding',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await cp.transition('r-direct-binding', 'EXECUTE');
    await cp.transition('r-direct-binding', 'PROVE');

    await assert.rejects(
      () => cp.executeProof('r-direct-binding', { obligationId: 'acceptance-ac-1', commandRef: 'test:unbound' }),
      (error) => {
        assert.equal(assertTestRecord(error).code, 'COMMAND_NOT_BOUND_TO_OBLIGATION');
        return true;
      },
    );
    assert.equal(existsSync(path.join(fixture.projectRoot, 'unbound-proof-ran')), false, 'the rejected direct proof must not execute its command');
    assert.equal(cp.stateStore.getVerifications('r-direct-binding').length, 0);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-2: an approved discovered command is not falsely rejected for a required_verification obligation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-discovered-required-verification';
    const run = await cp.startRun({ runId, objective: 'x' });
    cp.stateStore.declareRunObligations(runId, [{
      obligationId: 'required-verification-fixture',
      sourceType: 'knowledge',
      sourceRef: 'knowledge-fixture',
      evidenceClass: 'hard',
      verificationMethod: 'unit-test',
      allowedCommandRefs: ['test:ok'],
      rejectedCommandRefs: [],
      acceptanceIds: [],
      protected: false,
      contractRevision: run.contractRevision,
      metadata: { scope: ['app.mjs'] },
    }]);
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');

    const result = await cp.executeProof(runId, {
      obligationId: 'required-verification-fixture',
      commandRef: 'test:ok',
      discovered: {
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        approval: { approvedBy: 'kernel-test', approvalReceipt: 'approval://required-verification-fixture' },
      },
    });
    assert.equal(result.execution.status, 'passed');
    assert.equal(result.execution.trust, 'approved-discovered');
    assert.equal(cp.stateStore.getVerifications(runId)[0].commandRef, null, 'discovered evidence has no trusted manifest commandRef');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('F2: an active Run revision replaces the current acceptance authority', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.ensureRun({ runId: 'r-f2', objective: 'x', taskContract: { allowedPaths: ['app.mjs'], acceptance: ['A must hold', 'B must hold'] } });
    // A revised Task Contract is the current Goal authority. It is not an
    // append-only history and does not require abandoning the Run.
    await cp.ensureRun({ runId: 'r-f2', objective: 'x', taskContract: { allowedPaths: ['app.mjs'], acceptance: ['C must hold'] } });

    const run = await cp.getRun('r-f2');
    assert.deepEqual(assertTestPresent(run).acceptanceCriteria, ['C must hold']);
    assert.equal(assertTestPresent(assertTestPresent(assertTestPresent(run).taskContract).acceptance.find((item) => item.id === 'AC-1')).statement, 'C must hold');
    assert.equal(assertTestPresent(run).status, 'active');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('active replacement rebuilds a synthetic work-unit scope from the new contract', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.ensureRun({ runId: 'r-synthetic-scope', objective: 'x', taskContract: { allowedPaths: ['old/**'], acceptance: ['old holds'] } });
    await cp.ensureRun({ runId: 'r-synthetic-scope', objective: 'x', taskContract: { allowedPaths: ['new/**'], acceptance: ['new holds'] } });
    const next = await cp.next('r-synthetic-scope');
    assert.deepEqual(assertTestRecord(assertTestRecord(assertTestRecord(next).action).step).allowedPaths, ['new/**']);
    assert.deepEqual(assertTestRecord(assertTestRecord(assertTestRecord(next).action).step).acceptanceIds, ['AC-1']);
    assert.ok(assertTestArray(assertTestRecord(assertTestRecord(assertTestRecord(next).workAuthority).currentWorkUnit).obligationIds).includes('default'));
    assert.deepEqual(assertTestRecord(next).allowedPaths, ['new/**']);
    assert.deepEqual(assertTestRecord(next).acceptanceIds, ['AC-1']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('F3: two live processes sharing the fallback holder still conflict', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-f3', objective: 'x' });
    const store = await (await import('../src/kernel/state-store.js')).openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const holder = 'shared:project:holder';
      const processObservation = createHostProcessObservation();
      // A different, still-running process holds the lease under the same
      // fallback holder string.
      store.recordLease('r-f3', { holder, expiresAt: new Date(Date.now() + 600000).toISOString(), fencingToken: 1, ownerPid: process.ppid });
      const conflicted = store.acquireLease('r-f3', { holder, ...processObservation });
      assert.equal(conflicted.acquired, false, 'a live foreign pid under the same holder is a real conflict');

      // A holder whose owning process has exited is not a conflict, so
      // consecutive CLI invocations of one session still proceed.
      store.recordLease('r-f3', { holder, expiresAt: new Date(Date.now() + 600000).toISOString(), fencingToken: 2, ownerPid: 999999 });
      assert.equal(store.acquireLease('r-f3', { holder, ...processObservation }).acquired, true);
    } finally {
      store.close();
    }
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-3: a protected judgment obligation requires a named reviewer and rationale', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-review', objective: 'x', taskContract: { riskTier: 'T3' } });
    const bare = await cp.report('r-review', {
      summary: 'assert security',
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reason: 'fine' }],
    });
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(bare)).failures)[0]).errorSummary), /requires a judgment with reviewerId and rationale/);

    const selfReviewed = await cp.report('r-review', {
      summary: 'assert security',
      implementerId: 'agent-1',
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reason: 'fine', reviewerId: 'agent-1', rationale: 'checked' }],
    });
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(selfReviewed)).failures)[0]).errorSummary), /independent of the implementer/);

    // F5: omitting implementerId must not skip the independence check.
    const omitted = await cp.report('r-review', {
      summary: 'assert security',
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reason: 'fine', reviewerId: 'anyone', rationale: 'checked' }],
    });
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(omitted)).failures)[0]).errorSummary), /requires the report to declare implementerId/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-4: the full task contract survives a process boundary', async () => {
  const fixture = await setup();
  const first = await createKernelControlPlane(fixture);
  try {
    await first.startRun({
      runId: 'r-contract',
      objective: 'Fix login error',
      taskContract: {
        acceptance: ['invalid password returns 401'],
        constraints: ['keep the public response shape'],
        nonGoals: ['do not redesign authentication'],
        risks: ['session handling is shared with SSO'],
      },
    });
  } finally {
    await first.close();
  }

  // A completely separate control plane, as a later CLI invocation would be.
  const second = await createKernelControlPlane(fixture);
  try {
    const next = await second.next('r-contract');
    assert.deepEqual(assertTestRecord(next).constraints, ['keep the public response shape']);
    assert.deepEqual(assertTestRecord(next).nonGoals, ['do not redesign authentication']);
    assert.deepEqual(assertTestRecord(next).risks, ['session handling is shared with SSO']);
    assert.deepEqual(assertTestRecord(next).acceptance, ['invalid password returns 401']);

    const run = await second.getRun('r-contract');
    assert.equal(assertTestPresent(run).contractRevision, 1);
    assert.equal(assertTestPresent(assertTestPresent(run).taskContract).acceptance[0].id, 'AC-1');
  } finally {
    await second.close();
    await cleanup(fixture);
  }
});

test('P0-5: an evidence plan is compiled into a bound obligation, not just validated', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const run = await cp.startRun({
      runId: 'r-plan',
      objective: 'x',
      taskContract: {
        acceptance: [{
          acceptance: 'invalid password returns 401',
          evidencePlan: { class: 'hard', method: 'integration-test', commandRefs: ['test:ok'] },
        }],
      },
    });
    const planned = run.requiredObligations.find((obligation) => obligation.startsWith('acceptance-'));
    assert.ok(planned, 'the evidence plan must produce its own obligation');

    const next = await cp.next('r-plan');
    const bound = assertTestArray(assertTestRecord(assertTestRecord(next).action).obligations).find((entry: unknown) => assertTestRecord(entry).obligationId === planned);
    assert.deepEqual(assertTestRecord(bound).allowedCommandRefs, ['test:ok']);
    assert.deepEqual(assertTestRecord(bound).acceptanceIds, ['AC-1']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-5: an evidence plan supplied after FRAME is persisted as a contract revision', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-late', objective: 'x', taskContract: { acceptance: ['works'] } });
    await cp.report('r-late', {
      summary: 'planning evidence',
      evidencePlans: [{ acceptanceId: 'AC-1', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
    });
    const run = await cp.getRun('r-late');
    assert.equal(assertTestPresent(run).contractRevision, 2);
    assert.equal(assertTestPresent(assertTestPresent(assertTestPresent(run).taskContract).acceptance[0].evidencePlan).class, 'hard');
    assert.ok(assertTestPresent(run).requiredObligations.some((obligation) => obligation.startsWith('acceptance-')));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-5: replacing a hard evidence plan with judgment retires its predecessor obligation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-plan-replace',
      objective: 'x',
      taskContract: {
        acceptance: [{ id: 'AC-1', acceptance: 'visual target matches', evidencePlan: { class: 'hard', method: 'browser test', commandRefs: ['test:ok'] } }],
      },
    });
    const before = await cp.getRun('r-plan-replace');
    assert.ok(assertTestPresent(before).requiredObligations.includes('acceptance-ac-1'));

    const replacement = normalizeTaskContract({
      ...assertTestPresent(before).taskContract,
      acceptance: [{ id: 'AC-1', acceptance: 'visual target matches', evidencePlan: { class: 'judgment', method: 'independent visual review', commandRefs: [] } }],
    }, { objective: assertTestPresent(before).objective });
    const revised = await cp.reviseContract('r-plan-replace', replacement);

    assert.ok(!revised.requiredObligations.includes('acceptance-ac-1'), 'the superseded hard obligation is no longer required');
    assert.ok(revised.requiredObligations.includes('judgment-ac-1'));
    assert.equal(assertTestPresent(cp.stateStore.getRunObligation('r-plan-replace', 'acceptance-ac-1')).status, 'superseded');
    assert.equal(assertTestPresent(cp.stateStore.getRunObligation('r-plan-replace', 'judgment-ac-1')).status, 'required');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-2: AC coverage is canonicalized and cannot cross obligation boundaries', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-coverage-binding',
      objective: 'x',
      taskContract: {
        allowedPaths: ['app.mjs'],
        acceptance: [
          { id: 'AC-1', acceptance: 'auth behavior holds', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } },
          { id: 'AC-2', acceptance: 'static contract holds', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'] } },
        ],
      },
    });
    await mutate(fixture.projectRoot, 1);

    const unknown = await cp.report('r-coverage-binding', {
      summary: 'unknown AC coverage',
      verifications: [{ obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-999'] }],
    });
    assert.equal(assertTestPresent(unknown).status, 'evidence-rejected');
    assert.equal(assertTestArray(assertTestRecord(assertTestPresent(unknown)).executed).length, 0, 'unknown acceptance ids are rejected before command execution');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(unknown)).failures)[0]).errorCode, 'ACCEPTANCE_COVERAGE_UNKNOWN');

    const crossBound = await cp.report('r-coverage-binding', {
      summary: 'cross-bound AC coverage',
      verifications: [{ obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-2'] }],
    });
    assert.equal(assertTestPresent(crossBound).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(crossBound)).failures)[0]).errorCode, 'ACCEPTANCE_COVERAGE_NOT_BOUND');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-5: an unknown AC in a late evidence-plan submission is rejected, not ignored', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-unknown-plan', objective: 'x', taskContract: { allowedPaths: ['app.mjs'], acceptance: ['works'] } });
    const rejected = await cp.report('r-unknown-plan', {
      summary: 'unknown plan',
      evidencePlans: [{ acceptanceId: 'AC-404', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
    });
    assert.equal(assertTestPresent(rejected).status, 'evidence-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorCode, 'EVIDENCE_PLAN_UNKNOWN_ACCEPTANCE');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-4: a contract revision can replace acceptance, constraints, and scope authority', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.ensureRun({
      runId: 'r-shrink',
      objective: 'x',
      taskContract: { allowedPaths: ['app.mjs'], acceptance: ['A must hold', 'B must hold'], constraints: ['keep the response shape'] },
    });

    // A later turn submits the current contract. Removed criteria and
    // constraints are historical, not current completion authority.
    await cp.ensureRun({ runId: 'r-shrink', objective: 'x', taskContract: { allowedPaths: ['app.mjs'], acceptance: ['A must hold'] } });

    const run = await cp.getRun('r-shrink');
    assert.deepEqual(assertTestPresent(run).acceptanceCriteria, ['A must hold']);
    assert.deepEqual(assertTestPresent(assertTestPresent(run).taskContract).constraints, []);

    // Refinement in the same revision still lands.
    await cp.ensureRun({
      runId: 'r-shrink',
      objective: 'x',
      taskContract: { allowedPaths: ['app.mjs'], acceptance: ['C must hold'], nonGoals: ['no redesign'] },
    });
    const refined = await cp.getRun('r-shrink');
    assert.deepEqual(assertTestPresent(refined).acceptanceCriteria, ['C must hold']);
    assert.deepEqual(assertTestPresent(assertTestPresent(refined).taskContract).nonGoals, ['no redesign']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-1: the host bootstraps a run idempotently without a model-visible start command', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const created = await cp.ensureRun({ runId: 'r-boot', objective: 'Fix it', taskContract: { acceptance: ['works'] } });
    assert.equal(created.status, 'created');
    assert.equal(assertTestRecord(assertTestRecord(created.next).action).type, 'implement');

    const resumed = await cp.ensureRun({ runId: 'r-boot', objective: 'Fix it', taskContract: { acceptance: ['works'] } });
    assert.equal(resumed.status, 'resumed');
    assert.equal(assertTestPresent(resumed.run).runId, 'r-boot');
    assert.equal(assertTestPresent(resumed.run).contractRevision, 1, 'an unchanged contract must not churn revisions');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P0-6: a finished report releases its lease so the next process is not locked out', async () => {
  const fixture = await setup();
  const firstProcess = await createKernelControlPlane(fixture);
  try {
    await firstProcess.startRun({
      runId: 'r-lease',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await mutate(fixture.projectRoot, 1);
    const failed = await firstProcess.report('r-lease', {
      summary: 'attempt',
      verifications: [{ obligationId: 'default', commandRef: 'test:fail' }],
    });
    assert.equal(assertTestPresent(failed).status, 'evidence-failed');
  } finally {
    await firstProcess.close();
  }

  // A distinct process (distinct PID) continuing the same session.
  const secondProcess = await createKernelControlPlane(fixture);
  try {
    const passed = await secondProcess.report('r-lease', {
      summary: 'retry',
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });
    assert.notEqual(assertTestPresent(passed).status, 'lease-conflict');
    assert.equal(assertTestPresent(passed).status, 'completed');
  } finally {
    await secondProcess.close();
    await cleanup(fixture);
  }
});

test('P0-6: leases carry a monotonic fencing token and a live holder still blocks', async () => {
  const fixture = await setup();
  const runnerA = await createKernelControlPlane({ ...fixture, holder: 'runner-A' });
  const runnerB = await createKernelControlPlane({ ...fixture, holder: 'runner-B' });
  try {
    await runnerA.startRun({ runId: 'r-fence', objective: 'x' });
    const held = await runnerA.resume('r-fence');
    assert.equal(held.status, 'resumed');

    const refused = await runnerB.report('r-fence', { summary: 'sneaky', verifications: [{ obligationId: 'default', commandRef: 'test:ok' }] });
    assert.equal(assertTestPresent(refused).status, 'lease-conflict');
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(refused)).lease).holder, 'runner-A');
    assert.ok(assertTestNumber(assertTestRecord(assertTestRecord(assertTestPresent(refused)).lease).fencingToken) >= 1);
  } finally {
    await runnerA.close();
    await runnerB.close();
    await cleanup(fixture);
  }
});

test('P0-7: accepted completion with incomplete finalization is neither done nor lost', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-final',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await mutate(fixture.projectRoot, 1);

    // Git closeout is requested but cannot succeed against this fixture.
    const reported = await cp.report('r-final', {
      summary: 'fix',
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
      gitCloseoutRequest: { requested: true, mode: 'commit', message: 'sentinel closeout' },
    });

    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(reported)).finalization).completionStatus, 'accepted');
    assert.notEqual(assertTestRecord(assertTestRecord(assertTestPresent(reported)).finalization).finalizationStatus, 'completed');
    assert.equal(assertTestPresent(reported).status, 'finalization-incomplete', 'a partial finalization must not be reported as completed');

    const next = await cp.next('r-final');
    assert.equal(assertTestRecord(assertTestRecord(next).action).type, 'finalize', 'the model must be told finalization is outstanding');

    const run = await cp.getRun('r-final');
    assert.notEqual(assertTestPresent(run).finalizationStatus, 'completed');

    // The run stays retryable instead of short-circuiting to "completed".
    const retried = await cp.report('r-final', { summary: 'retry finalization' });
    assert.notEqual(assertTestPresent(retried).status, 'completed');
    assert.ok(assertTestRecord(assertTestPresent(retried)).finalization, 'a retry must re-enter finalization');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('F4: a requested Git closeout that did not complete keeps finalization partial', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-f4',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await mutate(fixture.projectRoot, 1);

    // A closeout is requested but cannot complete against this fixture.
    const first = await cp.report('r-f4', {
      summary: 'fix',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
      gitCloseoutRequest: { requested: true, mode: 'commit', message: 'closeout' },
    });
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(first)).finalization).completionStatus, 'accepted');
    assert.notEqual(assertTestRecord(assertTestRecord(assertTestPresent(first)).finalization).finalizationStatus, 'completed');
    // The paths the closeout needs are persisted for the retry.
    assert.deepEqual(assertTestRecord(assertTestRecord(assertTestPresent(first)).finalization).changedPaths, ['app.mjs']);

    // The payload-less retry must not turn an unfinished closeout into a clean
    // completion by losing the selected paths.
    const retried = await cp.report('r-f4', { summary: 'retry finalization' });
    assert.notEqual(assertTestPresent(retried).status, 'completed');
    assert.notEqual(assertTestRecord(assertTestRecord(assertTestPresent(retried)).finalization).finalizationStatus, 'completed');
    assert.deepEqual(assertTestRecord(assertTestRecord(assertTestPresent(retried)).finalization).changedPaths, ['app.mjs'], 'the retry keeps the paths from the original request');

    const next = await cp.next('r-f4');
    assert.equal(assertTestRecord(assertTestRecord(next).action).type, 'finalize');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P1-1: the route is fixed at start and boundary judgment stays inside FRAME', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const plain = await cp.startRun({ runId: 'r-plain', objective: 'x' });
    assert.deepEqual(assertTestPresent(plain.route).stages, ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE']);
    await cp.abandonRun('r-plain');

    const boundary = await cp.startRun({ runId: 'r-shape', objective: 'x', taskContract: { publicContract: true } });
    assert.deepEqual(assertTestPresent(boundary.route).stages, ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE']);
    assert.deepEqual(Object.keys(assertTestRecord(boundary.route)).sort(), ['riskTier', 'stages']);
    // A public-contract surface also raises the proof tier floor.
    assert.equal(boundary.proofTier, 'T2');
    await cp.abandonRun('r-shape');

    // Declared behaviour change reaches the tier resolver.
    const behaviour = await cp.startRun({ runId: 'r-behaviour', objective: 'x', taskContract: { behaviorChanging: true } });
    assert.equal(behaviour.proofTier, 'T1');
    assert.deepEqual(behaviour.requiredObligations, ['unit-test']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P1-1: report follows the stored route instead of the shortest path to PROVE', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-route',
      objective: 'x',
      taskContract: {
        publicContract: true,
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await mutate(fixture.projectRoot, 1);
    await cp.report('r-route', {
      summary: 'implement',
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });
    const attempts = assertTestRecord(assertTestPresent((await cp.status('r-route')))).run;
    assert.ok(assertTestRecord(attempts).state === 'CLOSE' || assertTestRecord(attempts).state === 'PROVE');
    // The boundary judgment no longer creates a separate lifecycle state.
    const receipt = await cp.buildStageContext('r-route', { stage: 'EXECUTE' });
    assert.equal(receipt.schemaVersion, 1);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('P1-2/P1-3: next carries stage guidance, obligations, and repository evidence', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-ctx', objective: 'x', taskContract: { acceptance: ['works'], behaviorChanging: true } });
    const next = await cp.next('r-ctx');

    assert.equal(assertTestRecord(assertTestRecord(next).action).type, 'implement');
    assert.ok(Array.isArray(assertTestRecord(next).capabilities) && assertTestNumber(assertTestArray(assertTestRecord(next).capabilities).length) > 0, 'conditional capabilities must reach the model');
    assert.ok(assertTestArray(assertTestRecord(assertTestRecord(next).action).obligations).every((entry: unknown) => assertTestRecord(entry).evidenceClass && Array.isArray(assertTestRecord(entry).allowedCommandRefs)));
    assert.ok(assertTestRecord(assertTestRecord(next).action).projectContext, 'implementation guidance must be attached to the implement action');
    assert.ok(Array.isArray(assertTestRecord(assertTestRecord(assertTestRecord(next).action).projectContext).knownCommands));
    // The internal project-mode classification is never named to the model.
    assert.ok(!JSON.stringify(next).includes('brownfield'));
    assert.ok(!JSON.stringify(next).includes('greenfield'));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('successor contract merge rebases local step AC ids to canonical merged ids', () => {
  const previous = normalizeTaskContract({
    acceptance: [{
      id: 'AC-1',
      acceptance: 'the predecessor invariant holds',
      evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'predecessor-check' },
    }],
    requiredObligations: ['predecessor-check'],
    steps: [{
      objective: 'predecessor',
      allowedPaths: ['app.mjs'],
      acceptanceIds: ['AC-1'],
      obligationIds: ['predecessor-check'],
    }],
  }, { objective: 'predecessor' });
  const successor = normalizeTaskContract({
    acceptance: [{
      id: 'AC-1',
      acceptance: 'the successor binding is rebased',
      evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'successor-check' },
    }],
    requiredObligations: ['successor-check'],
    steps: [{
      objective: 'successor',
      allowedPaths: ['app.mjs'],
      acceptanceIds: ['AC-1'],
      obligationIds: ['successor-check'],
    }],
  }, { objective: 'successor' });

  const merged = mergeContractRevisionWithBindings(previous, successor);
  assert.deepEqual(merged.contract.acceptance.map((item) => item.id), ['AC-1', 'AC-2']);
  assert.equal(merged.acceptanceIdMap['AC-1'], 'AC-2');
  assert.deepEqual(merged.contract.steps[0].acceptanceIds, ['AC-2']);
  assert.deepEqual(merged.contract.steps[0].obligationIds, ['successor-check']);
});

test('successor contract merge fails closed for unknown or omitted acceptance bindings', () => {
  const previous = normalizeTaskContract({
    acceptance: [{ acceptance: 'old', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'old-check' } }],
    requiredObligations: ['old-check'],
    steps: [{ objective: 'old', acceptanceIds: ['AC-1'], obligationIds: ['old-check'] }],
  }, { objective: 'old' });
  const unknown = normalizeTaskContract({
    acceptance: [{ acceptance: 'new', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'new-check' } }],
    requiredObligations: ['new-check'],
    steps: [{ objective: 'new', acceptanceIds: ['AC-999'], obligationIds: ['new-check'] }],
  }, { objective: 'new' });
  assert.throws(
    () => mergeContractRevisionWithBindings(previous, unknown),
    (error) => assertTestRecord(error).code === 'CONTRACT_STEP_ACCEPTANCE_UNKNOWN',
  );

  const omitted = normalizeTaskContract({
    acceptance: [{ acceptance: 'new', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'new-check' } }],
    requiredObligations: ['new-check'],
    steps: [{ objective: 'new', acceptanceIds: [], obligationIds: ['new-check'] }],
  }, { objective: 'new' });
  assert.throws(
    () => mergeContractRevisionWithBindings(previous, omitted),
    (error) => assertTestRecord(error).code === 'CONTRACT_STEP_ACCEPTANCE_OMITTED',
  );
});

test('contract revision atomically rebases steps and keeps predecessor coverage canonical', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-merge-rebase',
      objective: 'predecessor',
      taskContract: {
        acceptance: [{ acceptance: 'old', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'old-check' } }],
        requiredObligations: ['old-check'],
        steps: [{ objective: 'predecessor', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'], obligationIds: ['old-check'] }],
      },
    });
    await cp.transition('r-merge-rebase', 'EXECUTE');
    await cp.transition('r-merge-rebase', 'PROVE');
    await cp.recordProof('r-merge-rebase', {
      obligationId: 'old-check',
      status: 'passed',
      evidenceRef: 'proof://old',
      command: 'npm run test:ok',
      commandRef: 'test:ok',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: ['AC-1'],
    });

    await cp.ensureRun({
      runId: 'r-merge-rebase',
      objective: 'successor',
      taskContract: {
        acceptance: [{ acceptance: 'new', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'new-check' } }],
        requiredObligations: ['new-check'],
        steps: [{ objective: 'successor', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'], obligationIds: ['new-check'] }],
      },
    });

    const run = await cp.getRun('r-merge-rebase');
    assert.equal(assertTestPresent(run).contractRevision, 2);
    assert.deepEqual(assertTestPresent(assertTestPresent(run).taskContract).acceptance.map((item) => item.id), ['AC-1']);
    assert.deepEqual(assertTestPresent(cp.getCurrentStep('r-merge-rebase')).acceptanceIds, ['AC-1']);
    assert.equal(assertTestPresent(cp.stateStore.getRunObligation('r-merge-rebase', 'old-check')).status, 'superseded');
    assert.deepEqual(assertTestPresent(cp.stateStore.getRunObligation('r-merge-rebase', 'new-check')).acceptanceIds, ['AC-1']);
    assert.deepEqual(cp.stateStore.getVerifications('r-merge-rebase')[0].acceptanceCoverage, ['AC-1']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('contract revision rolls back when persisted coverage cannot be rebound', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-merge-rollback',
      objective: 'predecessor',
      taskContract: {
        allowedPaths: ['app.mjs'],
        acceptance: [{ acceptance: 'old', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'old-check' } }],
        requiredObligations: ['old-check'],
        steps: [{ objective: 'predecessor', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'], obligationIds: ['old-check'] }],
      },
    });
    cp.stateStore.addWaiver('r-merge-rollback', {
      obligationId: 'old-check',
      approvedBy: 'fixture',
      reason: 'fixture coverage rollback',
      approvalReceipt: 'approval://fixture',
      acceptanceCoverage: ['AC-999'],
    });

    await assert.rejects(
      cp.ensureRun({
        runId: 'r-merge-rollback',
        objective: 'successor',
        taskContract: {
          allowedPaths: ['app.mjs'],
          acceptance: [{ acceptance: 'new', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'new-check' } }],
          requiredObligations: ['new-check'],
          steps: [{ objective: 'successor', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'], obligationIds: ['new-check'] }],
        },
      }),
      (error) => assertTestRecord(error).code === 'CONTRACT_COVERAGE_REBASE_FAILED',
    );
    const unchanged = await cp.getRun('r-merge-rollback');
    assert.equal(assertTestPresent(unchanged).contractRevision, 1);
    assert.deepEqual(assertTestPresent(assertTestPresent(unchanged).taskContract).acceptance.map((item) => item.statement), ['old']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
