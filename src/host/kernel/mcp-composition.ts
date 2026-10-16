// Single Host composition seam for the Kernel MCP bridge.
//
// Kernel domain modules must not import Host implementations. The public MCP
// bridge is a composition surface, so all Host wiring crosses this one module
// rather than growing per-service boundary exceptions.

export { createKernelControlPlane } from './control-plane-runtime.js';
export { resolveKernelWorktreeIdentity } from './workspace/worktree-resolution.js';
export {
  createKernelHostReviewBridge,
  isKernelReviewAction,
} from './lifecycle-bridge.js';
export {
  createKernelRecoveryContinuity,
  diagnoseKernelRecovery,
  type KernelRecoveryContinuity,
} from './run/agent-recovery.js';
