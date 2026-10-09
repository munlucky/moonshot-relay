import { executeTrustedProof } from './proof-executor.mjs';
import { observeWorkspaceIdentity } from '../run/workspace-identity.mjs';

// Captures a pre-change baseline (§16.3): runs the requested trusted commands
// as-is and records which already fail, so later failures can be classified
// against ground truth rather than assumed to be task-caused.
export const captureBaselineProof = ({ projectRoot = process.cwd(), commandRefs = [], timeoutMs, evidenceDir } = {}) => {
  const observation = observeWorkspaceIdentity({ projectRoot });
  const results = [];
  const baselineFailures = [];

  for (const commandRef of commandRefs) {
    let execution;
    try {
      execution = executeTrustedProof({ projectRoot, commandRef, timeoutMs, evidenceDir });
    } catch (error) {
      results.push({ commandRef, status: 'unsupported', error: error.message });
      continue;
    }
    results.push({ commandRef, status: execution.status, exitCode: execution.exitCode });
    if (execution.status !== 'passed') {
      baselineFailures.push({ obligationId: commandRef, commandRef, exitCode: execution.exitCode });
    }
  }

  return {
    workspaceIdentity: observation.identity,
    capturedAt: observation.observedAt,
    results,
    baselineFailures,
  };
};
