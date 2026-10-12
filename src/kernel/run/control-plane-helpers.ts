import { requiredIndex } from '../../shared/required-index.js';
import { buildCandidateIdentity, sha256Hex } from '../../shared/candidate-identity.js';
import { isProtectedObligation } from '../proof/protected-obligations.js';
import type { KernelState } from '../transition.js';
import type { TaskContractLike, ContractStep } from '../task/task-contract.js';
interface StepIdentity { stepId?: unknown; objective?: unknown; sequence?: unknown }
interface StepScope extends StepIdentity { allowedPaths?: unknown; forbiddenPaths?: unknown; acceptanceIds?: unknown; obligationIds?: unknown }
export const canonicalChangedPaths = (paths: unknown): string[] => [...new Set((Array.isArray(paths) ? paths : [])
  .map((entry) => String(entry).replaceAll('\\', '/').replace(/^\.\//u, ''))
  .filter(Boolean))].sort();

export const canonicalReceiptValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonicalReceiptValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalReceiptValue((value as Record<string, unknown>)[key])]));
};

export const receiptValuesEqual = (left: unknown, right: unknown, { paths = false }: { paths?: boolean } = {}) => JSON.stringify(
  canonicalReceiptValue(paths ? canonicalChangedPaths(left) : left),
) === JSON.stringify(canonicalReceiptValue(paths ? canonicalChangedPaths(right) : right));

export const computeKernelSourceIdentity = ({ projectRoot = process.cwd(), sourceDigest = null, objective = '', taskContract = {} }: { projectRoot?: string; sourceDigest?: string | null; objective?: string; taskContract?: TaskContractLike } = {}) => {
  const trustedSourceDigest = sourceDigest || sha256Hex({ projectRoot, objective });
  return buildCandidateIdentity({
    profile: 'kernel',
    source: trustedSourceDigest,
    task: objective,
    spec: taskContract.spec || taskContract.acceptance || taskContract.acceptanceCriteria || [],
    environment: `${process.platform}:${process.arch}:${process.version}`,
    policy: 'moon-relay-kernel.v1',
  }).candidateId;
};

const FINDING_CLASS_RANK: Readonly<Record<string, number>> = Object.freeze({ critical: 3, important: 2, minor: 1 });

export const findingClassOf = (findings: unknown[] = []): string => {
  let highest = 'none';
  for (const finding of findings) {
    const severity = typeof finding === 'object' && finding ? String((finding as Record<string, unknown>).severity || 'minor') : 'minor';
    if ((FINDING_CLASS_RANK[severity] || 1) > (FINDING_CLASS_RANK[highest] || 0)) highest = severity in FINDING_CLASS_RANK ? severity : 'minor';
  }
  return highest;
};

// K0: which judgments may not rest on caller-supplied reviewer strings.
export const reviewReceiptRequired = ({ obligationId, declared, proofTier, independentReviewRequired = false }: { obligationId: string; declared?: { protected?: unknown; evidenceClass?: unknown } | null; proofTier?: (string) | undefined; independentReviewRequired?: boolean }) =>
  Boolean(declared?.protected)
  || isProtectedObligation(obligationId)
  || obligationId === 'security-review'
  || independentReviewRequired === true
  || (proofTier === 'T3' && (declared?.evidenceClass || 'hard') === 'judgment');

export const buildRunRoute = (contract: { taskClass?: unknown }, riskSummary: unknown): KernelState[] => {
  if (contract.taskClass === 'analysis') return ['FRAME', 'CLOSE'];
  return ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'];
};

export const resolveDeclaredStepForReplan = (contract: { steps?: ContractStep[] } | null, step: StepIdentity | null): ContractStep | null => {
  if (!step || !Array.isArray(contract?.steps)) return null;
  const byId = contract.steps.find((entry) => entry.stepId && String(entry.stepId) === step.stepId);
  if (byId) return byId;
  const byObjective = contract.steps.find((entry) => String(entry.objective || '') === String(step.objective || ''));
  if (byObjective) return byObjective;
  return contract.steps[Number(step.sequence) - 1] || null;
};

export const stepScopeChanged = (step: StepScope | null, declared: StepScope | null): boolean => {
  if (!step || !declared) return false;
  const normalized = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(String))].sort();
  return JSON.stringify(normalized(step.allowedPaths)) !== JSON.stringify(normalized(declared.allowedPaths))
    || JSON.stringify(normalized(step.forbiddenPaths)) !== JSON.stringify(normalized(declared.forbiddenPaths))
    || JSON.stringify(normalized(step.acceptanceIds)) !== JSON.stringify(normalized(declared.acceptanceIds))
    || JSON.stringify(normalized(step.obligationIds)) !== JSON.stringify(normalized(declared.obligationIds));
};

export const planDiffersFromContract = (steps: StepScope[] = [], declared: StepScope[] = []): boolean => {
  if (steps.length !== declared.length) return true;
  return steps.some((step, index) => (
    String(step.objective || '') !== String(declared[index]?.objective || '')
    || stepScopeChanged(step, requiredIndex(declared, index))
  ));
};
