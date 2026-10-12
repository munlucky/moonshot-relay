import { requiredIndex } from '../../shared/required-index.js';
import { validateSupersession } from './records.js';

export interface KnowledgeFactLike {
  id: string;
  projectId?: string | null;
  status?: string | null;
  supersedes?: string[];
  updatedAt?: string;
  [key: string]: unknown;
}

export interface SupersessionProposal {
  targetId: string;
  supersedingId: string;
  reason?: string | null;
}

export interface ApplySupersessionsInput<T extends KnowledgeFactLike = KnowledgeFactLike> {
  currentFacts?: T[];
  supersessionProposals?: SupersessionProposal[];
  projectId: string;
}

export function applySupersessions<T extends KnowledgeFactLike = KnowledgeFactLike>({
  currentFacts = [],
  supersessionProposals = [],
  projectId,
}: ApplySupersessionsInput<T>) {
  const updatedFacts: KnowledgeFactLike[] = [...currentFacts];
  const supersessionLogEntries: Array<{
    targetId: string;
    supersedingId: string;
    timestamp: string;
    reason: string;
  }> = [];

  for (const proposal of supersessionProposals) {
    validateSupersession(
      updatedFacts,
      proposal.targetId,
      proposal.supersedingId,
      { currentProjectId: projectId },
    );
    const targetIndex = updatedFacts.findIndex((fact) => fact.id === proposal.targetId);
    if (targetIndex < 0) continue;

    updatedFacts[targetIndex] = {
      ...requiredIndex(updatedFacts, targetIndex),
      status: 'superseded',
      updatedAt: new Date().toISOString(),
    };

    const supersedingIndex = updatedFacts.findIndex((fact) => fact.id === proposal.supersedingId);
    if (supersedingIndex >= 0) {
      const existingSupersedes = requiredIndex(updatedFacts, supersedingIndex).supersedes || [];
      if (!existingSupersedes.includes(proposal.targetId)) {
        updatedFacts[supersedingIndex] = {
          ...requiredIndex(updatedFacts, supersedingIndex),
          supersedes: [...existingSupersedes, proposal.targetId],
          updatedAt: new Date().toISOString(),
        };
      }
    }

    supersessionLogEntries.push({
      targetId: proposal.targetId,
      supersedingId: proposal.supersedingId,
      timestamp: new Date().toISOString(),
      reason: proposal.reason || 'superseded_by_candidate',
    });
  }

  return { updatedFacts: updatedFacts as T[], supersessionLogEntries };
}
