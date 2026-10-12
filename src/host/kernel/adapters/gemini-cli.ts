import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { sanitizePersistentText } from '../../../shared/persistent-sanitizer.js';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const asTokenStats = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

export interface GeminiCliParsedResult {
  status: string;
  resultStatus?: string;
  sessionId?: string;
  resolvedModel?: string | null;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedInputTokens?: unknown;
  report?: UnknownRecord;
  outcome?: UnknownRecord;
  errorCode?: string;
  errorSummary?: string;
}

export const parseGeminiCliResult = (
  stdout: string,
  { review = false }: { review?: (boolean) | undefined } = {},
): GeminiCliParsedResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: 'failed', errorCode: 'gemini_cli_output_invalid' };
  }
  const value = asRecord(parsed);
  const error = asRecord(value.error);
  if (Object.keys(error).length > 0) {
    return {
      status: 'blocked',
      errorCode: `gemini_cli_error_${String(error.code ?? 'unknown')}`,
      errorSummary: sanitizePersistentText(
        String(error.message || 'Gemini CLI failed'),
      ),
    };
  }
  if (!value.session_id || typeof value.response !== 'string') {
    return {
      status: 'failed',
      errorCode: 'gemini_cli_terminal_evidence_missing',
    };
  }

  let responseValue: unknown;
  try {
    responseValue = JSON.parse(value.response);
  } catch {
    return { status: 'failed', errorCode: 'gemini_worker_output_invalid' };
  }
  const response = asRecord(responseValue);
  if (
    review
      ? !['pass', 'fail', 'blocked'].includes(String(response.verdict || ''))
      : !['completed', 'blocked', 'failed'].includes(String(response.status || ''))
  ) {
    return { status: 'failed', errorCode: 'gemini_worker_output_invalid' };
  }

  const stats = asRecord(value.stats);
  const modelsRecord = asRecord(stats.models);
  const models = Object.entries(modelsRecord);
  const singleModel = models.length === 1 ? models[0] : null;
  const modelStats = singleModel ? asRecord(singleModel[1]) : null;
  const tokens = asTokenStats(modelStats?.tokens);

  return {
    status: 'completed',
    resultStatus: review ? 'completed' : String(response.status),
    sessionId: String(value.session_id),
    resolvedModel: singleModel ? singleModel[0] : null,
    inputTokens: tokens?.prompt ?? null,
    outputTokens: tokens?.candidates ?? null,
    cachedInputTokens: tokens?.cached ?? null,
    ...(review ? { outcome: response } : { report: response }),
  };
};

interface GeminiCliLaunchRequest {
  message: string;
  readOnly?: boolean;
  model?: string | null;
  workingDirectory?: string | null;
  environment?: NodeJS.ProcessEnv | null;
}

type GeminiProcessRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

// A fixed native transport, with no shell, retries, worktree manager, or resume
// database. Spawn each Work in a fresh process; physical cwd is Host-supplied.
export const createGeminiCliLauncher = ({
  command = 'gemini',
  args = [],
  timeoutMs = 55000,
  runProcess = spawnSync,
}: {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
  runProcess?: GeminiProcessRunner;
} = {}) => (
  request: GeminiCliLaunchRequest,
): GeminiCliParsedResult & { wallClockMs: number } => {
  const startedAt = Date.now();
  const child = runProcess(command, [
    ...args,
    '--prompt',
    request.message,
    '--output-format',
    'json',
    '--skip-trust',
    '--approval-mode',
    request.readOnly ? 'plan' : 'auto_edit',
    ...(request.model ? ['--model', request.model] : []),
  ], {
    cwd: request.workingDirectory || process.cwd(),
    env: request.environment
      ? { ...process.env, ...request.environment }
      : process.env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: Math.min(timeoutMs, 55000),
    maxBuffer: 4 * 1024 * 1024,
  });

  if (child.error) {
    const code = 'code' in child.error && child.error.code
      ? String(child.error.code)
      : 'gemini_cli_launch_failed';
    return {
      status: 'blocked',
      errorCode: code,
      errorSummary: sanitizePersistentText(String(child.error.message)),
      wallClockMs: Date.now() - startedAt,
    };
  }

  const result = parseGeminiCliResult(String(child.stdout || ''), {
    review: request.readOnly,
  });
  if (child.status !== 0 && result.status === 'completed') {
    return {
      status: 'failed',
      errorCode: 'gemini_cli_exit_failed',
      wallClockMs: Date.now() - startedAt,
    };
  }
  return {
    ...result,
    wallClockMs: Date.now() - startedAt,
  };
};
