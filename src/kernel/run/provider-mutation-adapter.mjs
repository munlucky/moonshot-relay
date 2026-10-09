const operationForTool = (tool = '') => {
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

export const normalizeProviderMutationRequest = ({ provider, payload = {}, context = {} } = {}) => {
  const tool = payload.tool_name || payload.toolName || payload.name || payload.tool || '';
  const operation = payload.operation || operationForTool(tool);
  const input = payload.tool_input || payload.input || payload.arguments || payload.args || {};
  const candidates = [
    input.path, input.file, input.filePath, input.file_path, input.target,
    ...(Array.isArray(input.paths) ? input.paths : []),
    ...(Array.isArray(input.files) ? input.files : []),
  ].filter(Boolean).map(String);
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

export const guardProviderMutation = ({ controlPlane, provider, payload, context } = {}) => {
  const request = normalizeProviderMutationRequest({ provider, payload, context });
  if (!request.operation) return { allowed: true, reason: 'read_only_or_unclassified' };
  return controlPlane.assertMutationAllowed(request);
};
