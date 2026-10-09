const MAX_SUBJECT_LENGTH = 96;
const MAX_OBJECTIVE_LENGTH = 1200;
const MAX_ACCEPTANCE_STATEMENT_LENGTH = 240;
const MAX_COMMIT_MESSAGE_LENGTH = 12000;
const MAX_PATH_LINES = 80;

const portable = (value) => String(value || '').replaceAll('\\', '/');

const cleanMultiline = (value) => String(value || '')
  .replaceAll('\r\n', '\n')
  .replaceAll('\r', '\n')
  .replaceAll('\u0000', '')
  .split('\n')
  .map((line) => line.replace(/[\t ]+/gu, ' ').trimEnd())
  .join('\n')
  .trim();

const oneLine = (value) => cleanMultiline(value).replace(/[\s\n]+/gu, ' ').trim();

const truncate = (value, limit) => {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const normalizePaths = (values = []) => unique(values.map((value) => {
  const candidate = typeof value === 'object' && value !== null ? value.path : value;
  return portable(candidate).replace(/^\.\//u, '');
})).sort((left, right) => left.localeCompare(right));

const providedMessageParts = (message) => {
  const text = cleanMultiline(message);
  if (!text) return { subject: '', body: '' };
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return { subject: '', body: '' };
  return {
    subject: lines[first].trim(),
    body: lines.slice(first + 1).join('\n').trim(),
  };
};

export function deriveKernelCommitSubject({ message = null, objective = '', projectId = '' } = {}) {
  const provided = providedMessageParts(message).subject;
  if (provided) return truncate(oneLine(provided), MAX_SUBJECT_LENGTH);
  const summary = truncate(oneLine(objective), MAX_SUBJECT_LENGTH - 'feat(kernel): '.length);
  return truncate(
    summary ? `feat(kernel): ${summary}` : `chore(kernel): 검증된 작업 마감 기록 (${oneLine(projectId) || '프로젝트'})`,
    MAX_SUBJECT_LENGTH,
  );
}

const acceptanceRows = (contract) => (Array.isArray(contract?.acceptance) ? contract.acceptance : [])
  .map((entry) => {
    if (typeof entry === 'string') return { id: '', statement: entry };
    if (!entry || typeof entry !== 'object') return null;
    return {
      id: oneLine(entry.id || entry.acceptanceId || ''),
      statement: oneLine(entry.statement || entry.acceptance || entry.description || ''),
    };
  })
  .filter((entry) => entry && (entry.id || entry.statement));

const verificationRows = (completion) => {
  const candidate = completion?.decisionJson?.verifications || completion?.verifications;
  const source = Array.isArray(candidate) ? candidate : [];
  const rows = source.map((entry) => ({
    id: oneLine(entry?.obligationId || entry?.commandRef || entry?.command || ''),
    status: oneLine(entry?.status || 'recorded'),
  })).filter((entry) => entry.id);
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const acceptanceCoverage = (completion) => {
  const candidate = completion?.decisionJson?.verifications || completion?.verifications;
  const source = Array.isArray(candidate) ? candidate : [];
  return unique(source
  .flatMap((entry) => Array.isArray(entry?.acceptanceCoverage) ? entry.acceptanceCoverage : [])
  .map(oneLine)).sort((left, right) => left.localeCompare(right));
};

const boundedPathLines = (paths) => {
  if (paths.length <= MAX_PATH_LINES) return paths.map((entry) => `- ${entry}`);
  return [
    ...paths.slice(0, MAX_PATH_LINES).map((entry) => `- ${entry}`),
    `- ... ${paths.length - MAX_PATH_LINES} 추가 경로`,
  ];
};

const capMessage = (message) => {
  const max = MAX_COMMIT_MESSAGE_LENGTH - 1;
  if (message.length <= max) return message;
  const suffix = '\n- 커밋 메시지 길이 제한으로 추가 작업 정보는 생략됨.';
  return `${message.slice(0, max - suffix.length).trimEnd()}${suffix}`;
};

const displayValue = (value) => {
  const normalized = oneLine(value);
  const labels = {
    accepted: '승인됨',
    blocked: '차단됨',
    failed: '실패',
    passed: '통과',
    recorded: '기록됨',
    committed: '커밋됨',
    'candidate-snapshot': '후보 스냅샷 기록',
    'approval-requested': '승인된 지식 마감 요청',
    'not-requested': '요청하지 않음',
    'accepted-evidence-not-recorded': '승인 근거 미기록',
    unknown: '미기록',
    commit: '커밋',
    commit_and_push: '커밋 및 푸시',
  };
  return labels[normalized] || normalized;
};

export function buildKernelCommitMessage({
  message = null,
  run = null,
  completion = null,
  projectId = null,
  selectedPaths = [],
  excludedPaths = [],
  knowledgeCommitReceipt = null,
  knowledgeStatus = null,
  closeoutMode = null,
  verificationRefs = [],
} = {}) {
  const taskContract = run?.taskContract || {};
  const supplied = providedMessageParts(message);
  const subject = deriveKernelCommitSubject({ message, objective: run?.objective || taskContract.objective, projectId: projectId || run?.projectId });
  const selected = normalizePaths(selectedPaths);
  const excluded = normalizePaths(excludedPaths);
  const acceptances = acceptanceRows(taskContract);
  const verifications = verificationRows(completion);
  const covered = acceptanceCoverage(completion);
  const evidenceDigest = oneLine(completion?.evidenceDigest || completion?.decisionJson?.evidenceDigest || '');
  const hasKnowledge = Boolean(knowledgeStatus || knowledgeCommitReceipt?.status);
  const knowledge = hasKnowledge ? oneLine(knowledgeStatus || knowledgeCommitReceipt?.status) : null;
  const lines = [subject, ''];

  // The final Run may describe only admission or push. Its objective/ACs must
  // not displace an authored explanation of the actual patch. Full operational
  // details remain in the commit receipt and Git already stores changed paths.
  if (supplied.body) {
    lines.push(supplied.body, '');
    if (run?.runId) lines.push(`Kernel-Run: ${oneLine(run.runId)}`);
    if (evidenceDigest) lines.push(`Kernel-Evidence: ${evidenceDigest}`);
    if (verifications.length > 0) lines.push(`Kernel-Verification: ${verifications.map((entry) => `${entry.id}=${displayValue(entry.status)}`).join(', ')}`);
    else if (verificationRefs.length > 0) lines.push(`Kernel-Verification: ${unique(verificationRefs.map(oneLine)).join(', ')}`);
    return `${capMessage(lines.join('\n').trim())}\n`;
  }

  lines.push('Kernel 작업:');
  if (run?.objective || taskContract.objective) lines.push(`- 작업 목표: ${truncate(oneLine(run?.objective || taskContract.objective), MAX_OBJECTIVE_LENGTH)}`);
  if (run?.runId) lines.push(`- 실행 ID: ${oneLine(run.runId)}`);
  if (projectId || run?.projectId) lines.push(`- 프로젝트: ${oneLine(projectId || run.projectId)}`);
  if (run?.planRevision !== undefined || taskContract.planRevision !== undefined) lines.push(`- 계획 리비전: ${run?.planRevision ?? taskContract.planRevision}`);
  if (run?.mutationRevision !== undefined) lines.push(`- 변경 리비전: ${run.mutationRevision}`);
  if (run?.proofTier || taskContract.proofTier || run?.evidenceTier || taskContract.evidenceTier) {
    lines.push(`- 증명/근거 등급: ${oneLine(run?.proofTier || taskContract.proofTier || 'unknown')}/${oneLine(run?.evidenceTier || taskContract.evidenceTier || 'unknown')}`);
  }
  lines.push(`- 완료 판정: ${displayValue(completion?.decision || completion?.decisionJson?.decision || 'accepted-evidence-not-recorded')}`);
  if (hasKnowledge && knowledge && knowledge !== 'not-requested') {
    lines.push(`- 지식 마감: ${displayValue(knowledge)}`);
  }
  if (closeoutMode) lines.push(`- Git 마감: ${displayValue(closeoutMode)}`);
  if (evidenceDigest) lines.push(`- 근거 다이제스트: ${evidenceDigest}`);

  if (covered.length > 0) lines.push(`- 인수조건 충족: ${covered.join(', ')}`);
  else if (acceptances.some((entry) => entry.id)) lines.push(`- 인수조건 범위: ${acceptances.map((entry) => entry.id).filter(Boolean).join(', ')}`);

  if (verifications.length > 0) {
    lines.push(`- 검증: ${verifications.map((entry) => `${entry.id}=${displayValue(entry.status)}`).join(', ')}`);
  } else if (verificationRefs.length > 0) {
    lines.push(`- 검증 참조: ${unique(verificationRefs.map(oneLine)).join(', ')}`);
  }

  if (acceptances.length > 0) {
    lines.push('', '인수조건 상세:');
    for (const entry of acceptances) {
      const label = entry.id ? `${entry.id}: ` : '';
      lines.push(`- ${label}${truncate(entry.statement, MAX_ACCEPTANCE_STATEMENT_LENGTH)}`);
    }
  }

  lines.push('', `변경 경로 (${selected.length}):`);
  lines.push(...(selected.length > 0 ? boundedPathLines(selected) : ['- 없음']));
  if (excluded.length > 0) lines.push(`제외 경로 (${excluded.length}): deny-list 또는 보호 경로이므로 커밋하지 않음`);

  return `${capMessage(lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim())}\n`;
}

export const commitMessageConstants = Object.freeze({
  maxSubjectLength: MAX_SUBJECT_LENGTH,
  maxObjectiveLength: MAX_OBJECTIVE_LENGTH,
  maxCommitMessageLength: MAX_COMMIT_MESSAGE_LENGTH,
});
