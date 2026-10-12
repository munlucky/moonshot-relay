type UnknownRecord = Record<string, unknown>;

export type ProviderMutationOperation =
  | 'file_write'
  | 'file_delete'
  | 'git_commit'
  | 'git_checkout'
  | 'git_reset'
  | 'dependency_install'
  | 'migration'
  | 'destructive_command';

export interface ProviderMutationContext {
  runId?: unknown;
  stepId?: unknown;
  capsuleId?: unknown;
  fencingToken?: unknown;
  sessionToken?: unknown;
}

export interface ProviderMutationRequest {
  provider: string;
  runId: unknown;
  stepId: unknown;
  capsuleId: unknown;
  fencingToken: unknown;
  sessionToken: unknown;
  operation: ProviderMutationOperation | string | null;
  targetPaths: string[];
}

export interface MutationControlPlane {
  assertMutationAllowed(request: ProviderMutationRequest): unknown;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const operationForTool = (tool = ''): ProviderMutationOperation | null => {
  const name = String(tool).toLowerCase();
  if (/(write|edit|patch)/.test(name)) return 'file_write';
  if (/(delete|remove|unlink)/.test(name)) return 'file_delete';
  if (/commit/.test(name)) return 'git_commit';
  if (/checkout/.test(name)) return 'git_checkout';
  if (/reset/.test(name)) return 'git_reset';
  if (/(install|add_dependency)/.test(name)) return 'dependency_install';
  if (/migrat/.test(name)) return 'migration';
  if (/(shell|exec|command)/.test(name)) return 'destructive_command';
  return null;
};

export const normalizeProviderMutationRequest = ({
  provider,
  payload = {},
  context = {},
}: {
  provider?: unknown;
  payload?: (UnknownRecord) | undefined;
  context?: (ProviderMutationContext) | undefined;
} = {}): ProviderMutationRequest => {
  const tool = payload.tool_name || payload.toolName || payload.name || payload.tool || '';
  const operation = (
    typeof payload.operation === 'string'
      ? payload.operation
      : operationForTool(String(tool))
  );

  const rawInput = payload.tool_input || payload.input || payload.arguments || payload.args || {};
  const input = asRecord(rawInput);
  const inputPaths = Array.isArray(input.paths) ? input.paths : [];
  const inputFiles = Array.isArray(input.files) ? input.files : [];

  const candidates = [
    input.path,
    input.file,
    input.filePath,
    input.file_path,
    input.target,
    ...inputPaths,
    ...inputFiles,
  ]
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .map(String);

  return {
    provider: String(provider || 'unknown'),
    runId: context.runId,
    stepId: context.stepId,
    capsuleId: context.capsuleId,
    fencingToken: context.fencingToken ?? null,
    sessionToken: context.sessionToken ?? null,
    operation,
    targetPaths: [...new Set(candidates)],
  };
};

export const guardProviderMutation = ({
  controlPlane,
  provider,
  payload,
  context,
}: {
  controlPlane?: MutationControlPlane;
  provider?: unknown;
  payload?: UnknownRecord;
  context?: ProviderMutationContext;
} = {}): unknown => {
  const request = normalizeProviderMutationRequest({ provider, payload, context });
  if (!request.operation) {
    return { allowed: true, reason: 'read_only_or_unclassified' };
  }
  if (!controlPlane) {
    throw new Error('mutation_control_plane_required');
  }
  return controlPlane.assertMutationAllowed(request);
};
