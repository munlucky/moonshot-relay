// Generated from schemas/kernel.context-receipt.schema.json. Edit the schema and run build:contracts.

export interface KernelContextReceipt {
  schemaVersion: 1;
  receiptId: string;
  stage: 'FRAME' | 'SHAPE' | 'SLICE' | 'SCHEDULE' | 'EXECUTE' | 'PROVE' | 'CLOSE';
  policyRevision: string;
  policyDigest: string | null;
  tokenEstimate: number;
  included: {
    id: string;
    layer: string;
    revision: string;
    contentDigest: string;
    sourceRef?: string;
    sourceDigest?: string;
    trust?: string;
    truncated?: boolean;
  }[];
  omitted: {
    id: string;
    reason: string;
  }[];
  digest: string;
}
