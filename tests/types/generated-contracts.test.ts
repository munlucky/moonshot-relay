import type { KernelWorkflowState } from '../../src/contracts/generated/kernel.workflow-state.js';
import type { KernelKnowledgeRecord } from '../../src/contracts/generated/kernel.knowledge-record.js';
import type { KernelReviewReceipt } from '../../src/contracts/generated/kernel.review-receipt.js';

const state: KernelWorkflowState = { schemaVersion: 1, runId: 'run', state: 'PROVE', history: ['FRAME'] };
const recordType: KernelKnowledgeRecord['type'] = 'architecture_decision';
const approval: KernelReviewReceipt['reviewer']['enforcementStatus'] = 'operator_approved';
// @ts-expect-error Generated schema version is a literal contract.
const wrongVersion: KernelWorkflowState['schemaVersion'] = 2;
// @ts-expect-error Workflow state is a closed generated union.
const wrongState: KernelWorkflowState['state'] = 'FINISHED';
// @ts-expect-error Knowledge types come from the canonical schema vocabulary.
const wrongRecordType: KernelKnowledgeRecord['type'] = 'provider_session';
// @ts-expect-error A boolean approval does not replace an enforcement status.
const wrongApproval: KernelReviewReceipt['reviewer']['enforcementStatus'] = true;
void [state, recordType, approval, wrongVersion, wrongState, wrongRecordType, wrongApproval];
