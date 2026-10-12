import { createHash } from 'node:crypto';

export interface SuccessorKeyInput {
  projectId?: unknown;
  predecessorRunId?: unknown;
  worktreeId?: unknown;
  workspaceId?: unknown;
  taskContractDigest?: unknown;
}

export class SuccessorCreationConflictError extends Error {
  readonly code = 'successor_creation_conflict';
  readonly errorCode = 'successor_creation_conflict';
  readonly nextAction: string;

  constructor(field: string) {
    super('successor_creation_conflict');
    this.name = 'SuccessorCreationConflictError';
    this.nextAction = `supply-${field}`;
  }
}

const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SuccessorCreationConflictError(field);
  }
  return value;
};

export const buildSuccessorKey = ({
  projectId,
  predecessorRunId,
  worktreeId,
  workspaceId,
  taskContractDigest,
}: SuccessorKeyInput = {}): string => {
  const identity = {
    projectId: required(projectId, 'project-id'),
    predecessorRunId: required(predecessorRunId, 'predecessor-run-id'),
    worktreeId: required(worktreeId || workspaceId, 'worktree-id'),
    taskContractDigest: required(taskContractDigest, 'task-contract-digest'),
  };
  return `successor-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
};
