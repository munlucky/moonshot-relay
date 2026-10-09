import { createHash, randomUUID } from 'node:crypto';

export const ACCESS_MODES = Object.freeze(['owner', 'reviewer', 'read_only']);
export const BINDING_STATUSES = Object.freeze(['active', 'inactive', 'expired', 'revoked']);

export const createBindingId = ({ sessionId, runId, projectId, workspaceId = null }) =>
  `binding-${createHash('sha256').update(JSON.stringify({ sessionId, runId, projectId, workspaceId, nonce: randomUUID() })).digest('hex').slice(0, 24)}`;

export const normalizeSessionBinding = (input = {}) => {
  if (!input.sessionId || !input.runId || !input.projectId) throw new Error('host_binding_missing');
  const accessMode = input.accessMode || 'owner';
  if (!ACCESS_MODES.includes(accessMode)) throw new Error('run_access_denied');
  const status = input.status || 'active';
  if (!BINDING_STATUSES.includes(status)) throw new Error('binding_status_invalid');
  return {
    bindingId: input.bindingId || createBindingId(input),
    sessionId: String(input.sessionId),
    provider: String(input.provider || 'unknown'),
    surface: input.surface ? String(input.surface) : null,
    runId: String(input.runId),
    projectId: String(input.projectId),
    workspaceId: input.workspaceId ? String(input.workspaceId) : null,
    workspaceRoot: input.workspaceRoot ? String(input.workspaceRoot) : null,
    accessMode,
    status,
    expiresAt: input.expiresAt || null,
  };
};
