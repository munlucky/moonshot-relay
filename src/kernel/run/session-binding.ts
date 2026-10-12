import { createHash, randomUUID } from 'node:crypto';

export const ACCESS_MODES = Object.freeze(['owner', 'reviewer', 'read_only'] as const);
export const BINDING_STATUSES = Object.freeze(['active', 'inactive', 'expired', 'revoked'] as const);

export type AccessMode = typeof ACCESS_MODES[number];
export type BindingStatus = typeof BINDING_STATUSES[number];

export interface SessionBindingInput {
  bindingId?: unknown;
  sessionId?: unknown;
  provider?: unknown;
  surface?: unknown;
  runId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  workspaceRoot?: unknown;
  accessMode?: unknown;
  status?: unknown;
  expiresAt?: unknown;
}

export interface SessionBindingIdentity {
  sessionId: unknown;
  runId: unknown;
  projectId: unknown;
  workspaceId?: unknown;
}

const isAccessMode = (value: unknown): value is AccessMode => (
  typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value)
);
const isBindingStatus = (value: unknown): value is BindingStatus => (
  typeof value === 'string' && (BINDING_STATUSES as readonly string[]).includes(value)
);

export const createBindingId = ({
  sessionId,
  runId,
  projectId,
  workspaceId = null,
}: SessionBindingIdentity): string => (
  `binding-${createHash('sha256')
    .update(JSON.stringify({ sessionId, runId, projectId, workspaceId, nonce: randomUUID() }))
    .digest('hex')
    .slice(0, 24)}`
);

export const normalizeSessionBinding = (input: SessionBindingInput = {}) => {
  if (!input.sessionId || !input.runId || !input.projectId) throw new Error('host_binding_missing');
  const accessMode = input.accessMode || 'owner';
  if (!isAccessMode(accessMode)) throw new Error('run_access_denied');
  const status = input.status || 'active';
  if (!isBindingStatus(status)) throw new Error('binding_status_invalid');

  const identity: SessionBindingIdentity = {
    sessionId: input.sessionId,
    runId: input.runId,
    projectId: input.projectId,
    workspaceId: input.workspaceId ?? null,
  };

  return {
    bindingId: input.bindingId ? String(input.bindingId) : createBindingId(identity),
    sessionId: String(input.sessionId),
    provider: String(input.provider || 'unknown'),
    surface: input.surface ? String(input.surface) : null,
    runId: String(input.runId),
    projectId: String(input.projectId),
    workspaceId: input.workspaceId ? String(input.workspaceId) : null,
    workspaceRoot: input.workspaceRoot ? String(input.workspaceRoot) : null,
    accessMode,
    status,
    expiresAt: input.expiresAt ? String(input.expiresAt) : null,
  };
};
