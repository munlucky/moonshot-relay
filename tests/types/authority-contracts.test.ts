import type { RunStep, StepState } from '../../src/kernel/run/run-step-ledger.js';
import type { CompletionOutcome } from '../../src/contracts/completion-outcomes.js';
import type {
  HostExecutionContract,
  HostSemanticRequirements,
} from '../../src/contracts/host-execution-contract.js';
import type { KnowledgeCommitReceiptInput } from '../../src/kernel/knowledge/receipt.js';

const validStep: RunStep = {
  stepId: 'step-1',
  sequence: 1,
  planRevision: 1,
  state: 'ready',
};

const validOutcome: CompletionOutcome = 'verified';

const requirements: HostSemanticRequirements = {
  freshContext: false,
  workspaceWrite: true,
  workspaceIsolation: false,
  parallelExecution: false,
  independentReview: false,
  modelSelection: true,
};

const hostContract: HostExecutionContract = {
  schemaVersion: 2,
  runId: 'run-1',
  decisionId: 'decision-1',
  actionKind: 'implement',
  role: 'implementer',
  permissions: 'workspace_write',
  executionClass: 'standard',
  workProfile: null,
  executionMode: 'sequential',
  requirements,
  delegation: null,
  freshSessionRequired: false,
  workUnit: {
    objective: 'change one bounded behavior',
    allowedPaths: ['src/example.ts'],
    forbiddenPaths: [],
    expectedOutputs: [],
  },
  capsule: null,
  attemptId: null,
};

const knowledgeReceipt: KnowledgeCommitReceiptInput = {
  runId: 'run-1',
  projectId: 'project-1',
  revisionBefore: '1',
  revisionAfter: '2',
};

void validStep;
void validOutcome;
void hostContract;
void knowledgeReceipt;

// @ts-expect-error Step state is a closed contract, not an arbitrary string.
const invalidStepState: StepState = 'completed';

// @ts-expect-error Trust outcomes cannot be provider or transport states.
const invalidOutcome: CompletionOutcome = 'uploaded';

// @ts-expect-error HostExecutionContract intentionally has no provider/model field.
const providerLeak: HostExecutionContract = { ...hostContract, provider: 'codex' };

// @ts-expect-error Knowledge commits require authoritative run identity.
const missingRunIdentity: KnowledgeCommitReceiptInput = {
  projectId: 'project-1',
  revisionBefore: '1',
  revisionAfter: '2',
};

void invalidStepState;
void invalidOutcome;
void providerLeak;
void missingRunIdentity;
