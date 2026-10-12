import { createHash } from 'node:crypto';

export interface UpstreamUpdateProposal {
  schemaVersion: 1;
  source: string;
  currentRef: string;
  observedRef: string;
  changes: unknown[];
  autoApply: false;
  status: 'up-to-date' | 'proposal-required';
  proposalDigest: string;
}

export interface ProposeUpstreamUpdateInput {
  source: string;
  currentRef: string;
  observedRef: string;
  changes?: unknown[];
}

export const proposeUpstreamUpdate = ({
  source,
  currentRef,
  observedRef,
  changes = [],
}: ProposeUpstreamUpdateInput): UpstreamUpdateProposal => {
  const payload = {
    schemaVersion: 1 as const,
    source,
    currentRef,
    observedRef,
    changes,
    autoApply: false as const,
    status: currentRef === observedRef ? 'up-to-date' as const : 'proposal-required' as const,
  };
  return {
    ...payload,
    proposalDigest: createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex'),
  };
};

export const assertNoAutoApply = (
  registry: { autoApply?: unknown },
): true => {
  if (registry.autoApply !== false) {
    throw new Error('Kernel upstream auto-apply is forbidden');
  }
  return true;
};
