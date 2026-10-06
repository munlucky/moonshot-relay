import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { buildKernelCommitMessage, commitMessageConstants, deriveKernelCommitSubject } from '../scripts/kernel/git/commit-message.mjs';
import { executeKernelGitCloseout } from '../scripts/kernel/git/closeout.mjs';
import { runGit } from '../scripts/lib/git-safe.mjs';
import { resolveCommitMessage } from '../scripts/kernel/standalone/kernel-commit.mjs';
import { spawnSync } from 'node:child_process';

test('authored change explanation leads compact provenance without operational context dumps', () => {
  const message = buildKernelCommitMessage({
    message: 'fix: informative closeout\n\n기존 요청 본문을 보존한다.',
    run: {
      runId: 'run-message-1',
      projectId: 'project-message-1',
      objective: '커밋 메시지의 작업 문맥을 강화한다',
      planRevision: 4,
      mutationRevision: 2,
      proofTier: 'T2',
      evidenceTier: 'E1',
      taskContract: {
        acceptance: [{ id: 'AC-1', statement: '작업 목표와 검증 결과를 확인할 수 있다.' }],
      },
    },
    completion: {
      decision: 'accepted',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      decisionJson: {
        verifications: [{ obligationId: 'unit-test', status: 'passed', acceptanceCoverage: ['AC-1'] }],
      },
    },
    projectId: 'project-message-1',
    selectedPaths: ['scripts\\kernel\\git\\commit-message.mjs'],
    excludedPaths: [{ path: '.env.local' }],
    knowledgeCommitReceipt: { status: 'committed', digest: 'knowledge-1' },
    closeoutMode: 'commit_and_push',
  });

  assert.equal(message.startsWith('fix: informative closeout\n'), true);
  assert.equal(message.startsWith('fix: informative closeout\n\n기존 요청 본문을 보존한다.\n'), true);
  assert.match(message, /기존 요청 본문을 보존한다\./u);
  assert.match(message, /Kernel-Run: run-message-1/u);
  assert.match(message, /Kernel-Evidence: sha256:a{64}/u);
  assert.match(message, /Kernel-Verification: unit-test=통과/u);
  assert.doesNotMatch(message, /요청 메시지:|Kernel 작업:|작업 목표:|인수조건 상세:|변경 경로|\.env\.local/u);
});

test('Kernel commit message generation derives a Korean fallback and stays bounded', () => {
  const subject = deriveKernelCommitSubject({ objective: '자동 제목을 생성한다' });
  assert.equal(subject, 'feat(kernel): 자동 제목을 생성한다');

  const message = buildKernelCommitMessage({
    run: {
      runId: 'run-bounded',
      projectId: 'project-bounded',
      objective: '긴 작업 목표 '.repeat(400),
      taskContract: {
        acceptance: Array.from({ length: 100 }, (_, index) => ({
          id: `AC-${index + 1}`,
          statement: `긴 인수조건 설명 ${index + 1} `.repeat(40),
        })),
      },
    },
    selectedPaths: Array.from({ length: 100 }, (_, index) => `src/generated/change-${index + 1}.mjs`),
  });

  assert.match(message, /^feat\(kernel\): 긴 작업 목표/u);
  assert.ok(message.length <= commitMessageConstants.maxCommitMessageLength);
  assert.doesNotMatch(message, /\u0000/u);
  assert.match(message, /추가 작업 정보는 생략됨/u);
});

test('Kernel Git closeout keeps file-authored product explanation in the commit and receipt', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-commit-message-repo-'));
  const runId = 'run-closeout-message';
  const receipts = [];
  try {
    runGit(repoRoot, ['init', '-b', 'main']);
    runGit(repoRoot, ['config', 'user.name', 'Kernel Test']);
    runGit(repoRoot, ['config', 'user.email', 'kernel-test@example.invalid']);
    await writeFile(path.join(repoRoot, 'initial.txt'), 'initial\n', 'utf8');
    runGit(repoRoot, ['add', '--all']);
    runGit(repoRoot, ['commit', '-m', 'fixture']);
    await writeFile(path.join(repoRoot, 'change.txt'), 'kernel change\n', 'utf8');
    const messageFile = path.join(repoRoot, '.git', 'message.txt');
    await writeFile(messageFile, 'fix: 작업 정보가 있는 closeout\n\n작업별 구현으로 계획 컨텍스트 부담을 줄인다.\n', 'utf8');

    const stateStore = {
      getRun: () => ({
        runId,
        projectId: 'project-closeout-message',
        objective: '커밋 closeout에 작업 정보를 기록한다',
        planRevision: 2,
        mutationRevision: 1,
        taskContract: { acceptance: [{ id: 'AC-1', statement: '생성된 커밋에서 작업 문맥을 확인할 수 있다.' }] },
      }),
      getCompletionDecision: () => ({
        decision: 'accepted',
        decisionJson: { verifications: [{ obligationId: 'message-test', status: 'passed', acceptanceCoverage: ['AC-1'] }] },
      }),
      recordGitCloseoutReceipt: (_runId, receipt) => receipts.push(receipt),
    };

    const result = await executeKernelGitCloseout({
      runId,
      projectId: 'project-closeout-message',
      stateStore,
      repoRoot,
      gitCloseoutRequest: {
        requested: true,
        mode: 'commit',
        approvalReceipt: 'approval://test/1',
        message: await resolveCommitMessage({ messageFile }),
      },
      knowledgeCommitReceipt: { status: 'committed', digest: 'knowledge-closeout-1' },
      changedFiles: ['change.txt'],
    });

    const commitBody = String(runGit(repoRoot, ['log', '-1', '--format=%B']).stdout || '').trim();
    assert.equal(result.status, 'completed');
    assert.equal(result.commitSubject, 'fix: 작업 정보가 있는 closeout');
    assert.equal(commitBody, result.commitMessage.trim());
    assert.match(commitBody, /작업별 구현으로 계획 컨텍스트 부담을 줄인다/u);
    assert.doesNotMatch(commitBody, /작업 목표:|인수조건 상세:/u);
    assert.match(commitBody, /Kernel-Verification: message-test=통과/u);
    assert.equal(receipts.at(-1).receiptJson.commitMessage, result.commitMessage);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('Invariant S1: Commit message omits knowledge closeout line when knowledge is null or pending', () => {
  const message = buildKernelCommitMessage({
    run: {
      runId: 'run-no-kn',
      projectId: 'project-no-kn',
      objective: '지식 마감 없는 커밋 메시지',
    },
    knowledgeCommitReceipt: null,
    selectedPaths: ['index.mjs'],
  });
  assert.doesNotMatch(message, /지식 마감:/u);
});

test('administrative final run cannot replace the multi-file implementation explanation', () => {
  const authored = 'feat(workflow): 작업별 구현\n\n큰 계획을 work 문서로 나누고 단계별 평가를 제공한다.\n\n검증: 66개 통과. ADE live 미검증.';
  const message = buildKernelCommitMessage({
    message: authored,
    run: { runId: 'run-closeout', objective: 'Verify and commit/push; repair links', taskContract: { acceptance: [{ id: 'AC-1', statement: 'candidate admitted for commit' }] } },
    selectedPaths: Array.from({ length: 50 }, (_, index) => `runtime/file-${index}.mjs`),
  });
  assert.ok(message.startsWith(authored + '\n\nKernel-Run: run-closeout'));
  assert.doesNotMatch(message, /Verify and commit|candidate admitted|runtime\/file-/u);
  assert.ok(message.length < 1000);
});

test('message file preserves Korean and literal shell text; invalid input fails before side effects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kernel-message-file-'));
  try {
    const messageFile = path.join(directory, 'message.txt');
    const body = 'feat: 한글\n\n본문의 `code`, $(literal), $HOME과 "quotes" 유지';
    await writeFile(messageFile, '\uFEFF' + body.replaceAll('\n', '\r\n'), 'utf8');
    assert.equal(await resolveCommitMessage({ cwd: directory, messageFile: 'message.txt' }), body);
    await assert.rejects(resolveCommitMessage({ message: 'subject', messageFile }), { code: 'COMMIT_MESSAGE_INPUT_CONFLICT' });
    await assert.rejects(resolveCommitMessage({ messageFile: true }), { code: 'COMMIT_MESSAGE_FILE_REQUIRED' });
    for (const text of ['', 'subject\n\n', 'subject\nbody\u0000']) {
      await writeFile(messageFile, text, 'utf8');
      await assert.rejects(resolveCommitMessage({ messageFile }), { code: 'COMMIT_MESSAGE_BODY_REQUIRED' });
    }
    await assert.rejects(resolveCommitMessage({ messageFile: path.join(directory, 'missing.txt') }), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('both CLI entrypoints forward message-file and reject conflicting input before registration', () => {
  for (const entry of ['scripts/kernel/standalone/kernel-commit.mjs', 'bin/kernel-commit.mjs']) {
    const result = spawnSync(process.execPath, [entry, '--message', 'subject', '--message-file', 'unused.txt', '--json'], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).errorCode, 'COMMIT_MESSAGE_INPUT_CONFLICT');
  }
});
