export interface ProofTimeoutCleanup {
  status: string;
  platform: string;
  targetPids: number[];
  reason?: string | null;
  survivors?: number[];
  classification?: string;
  launcherPid?: number;
  lineageSource?: string;
  results?: Array<{
    pid: number;
    status: string;
    exitCode: number | null;
    output: string;
  }>;
}

export interface CommandApproval {
  approvedBy?: unknown;
  approvalReceipt?: unknown;
  argvDigest?: unknown;
  [key: string]: unknown;
}

export interface ProofExecutionResult {
  obligationExecutor: 'kernel-runtime';
  trust: string;
  commandRef: string;
  command: string;
  args: string[];
  executedCommand: string;
  executedArgs: string[];
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  status: 'passed' | 'failed';
  stdoutDigest: string;
  stderrDigest: string;
  outputDigest: string;
  executedAt: string;
  durationMs: number;
  timeoutMs: number;
  networkIsolation: string;
  networkPolicy: string;
  networkMechanism: string | null;
  evidenceRef: string | null;
  errorSummary: string | null;
  timeoutCleanup: ProofTimeoutCleanup | null;
}

export interface TrustedProofInput {
  projectRoot?: string;
  commandRef?: (string | null) | undefined;
  timeoutMs?: (number) | undefined;
  evidenceDir?: string | null | undefined;
  networkPolicy?: unknown;
  env?: NodeJS.ProcessEnv;
}

export interface ApprovedProofInput {
  projectRoot?: string;
  command?: unknown;
  args?: unknown;
  approval?: (CommandApproval | null) | undefined;
  label?: string | null;
  timeoutMs?: (number) | undefined;
  evidenceDir?: string | null | undefined;
  networkPolicy?: unknown;
  env?: NodeJS.ProcessEnv;
}

export interface FlakyExecutionLike {
  status: string;
}
