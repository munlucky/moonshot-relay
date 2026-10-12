interface WorkspaceIdentityObservation {
  identity: string;
  observedAt?: string | null;
}

interface TrustedProofExecution {
  status: string;
  exitCode?: number | null;
}

interface BaselineProofInput {
  projectRoot?: string;
  commandRefs?: string[];
  timeoutMs?: (number) | undefined;
  evidenceDir?: string;
  observeWorkspaceIdentity?: (input: {
    projectRoot: string;
  }) => WorkspaceIdentityObservation;
  executeTrustedProof?: (input: {
    projectRoot: string;
    commandRef: string;
    timeoutMs?: (number) | undefined;
    evidenceDir?: (string) | undefined;
  }) => TrustedProofExecution;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

// Captures a pre-change baseline (§16.3): runs the requested trusted commands
// as-is and records which already fail, so later failures can be classified
// against ground truth rather than assumed to be task-caused.
export const captureBaselineProof = ({
  projectRoot = process.cwd(),
  commandRefs = [],
  timeoutMs,
  evidenceDir,
  observeWorkspaceIdentity,
  executeTrustedProof,
}: BaselineProofInput = {}) => {
  if (typeof observeWorkspaceIdentity !== 'function') {
    throw new Error('workspace_identity_observer_required');
  }
  if (typeof executeTrustedProof !== 'function') {
    throw new Error('trusted_proof_executor_required');
  }

  const observation = observeWorkspaceIdentity({ projectRoot });
  const results: Array<{
    commandRef: string;
    status: string;
    exitCode?: (number | null) | undefined;
    error?: string;
  }> = [];
  const baselineFailures: Array<{
    obligationId: string;
    commandRef: string;
    exitCode?: (number | null) | undefined;
  }> = [];

  for (const commandRef of commandRefs) {
    let execution: TrustedProofExecution;
    try {
      execution = executeTrustedProof({
        projectRoot,
        commandRef,
        timeoutMs,
        evidenceDir,
      });
    } catch (error: unknown) {
      results.push({
        commandRef,
        status: 'unsupported',
        error: errorMessage(error),
      });
      continue;
    }

    results.push({
      commandRef,
      status: execution.status,
      exitCode: execution.exitCode,
    });
    if (execution.status !== 'passed') {
      baselineFailures.push({
        obligationId: commandRef,
        commandRef,
        exitCode: execution.exitCode,
      });
    }
  }

  return {
    workspaceIdentity: observation.identity,
    capturedAt: observation.observedAt,
    results,
    baselineFailures,
  };
};
