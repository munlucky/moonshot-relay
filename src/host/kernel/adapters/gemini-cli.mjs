import { spawnSync } from 'node:child_process';
import { sanitizePersistentText } from '../../../kernel/persistent-sanitizer.mjs';

// Parse the Gemini CLI's documented JSON envelope, not requested model flags.
export const parseGeminiCliResult = (stdout, { review = false } = {}) => {
  let value;
  try { value = JSON.parse(stdout); } catch {
    return { status: 'failed', errorCode: 'gemini_cli_output_invalid' };
  }
  if (value.error) return {
    status: 'blocked', errorCode: `gemini_cli_error_${value.error.code ?? 'unknown'}`,
    errorSummary: sanitizePersistentText(String(value.error.message || 'Gemini CLI failed')),
  };
  if (!value.session_id || typeof value.response !== 'string') return {
    status: 'failed', errorCode: 'gemini_cli_terminal_evidence_missing',
  };
  let response;
  try { response = JSON.parse(value.response); } catch {
    return { status: 'failed', errorCode: 'gemini_worker_output_invalid' };
  }
  if (review ? !['pass', 'fail', 'blocked'].includes(response.verdict)
    : !['completed', 'blocked', 'failed'].includes(response.status)) {
    return { status: 'failed', errorCode: 'gemini_worker_output_invalid' };
  }
  const models = Object.entries(value.stats?.models || {});
  const tokens = models.length === 1 ? models[0][1]?.tokens : null;
  return {
    status: 'completed', resultStatus: review ? 'completed' : response.status,
    sessionId: value.session_id,
    resolvedModel: models.length === 1 ? models[0][0] : null,
    inputTokens: tokens?.prompt ?? null, outputTokens: tokens?.candidates ?? null,
    cachedInputTokens: tokens?.cached ?? null,
    ...(review ? { outcome: response } : { report: response }),
  };
};

// A fixed native transport, with no shell, retries, worktree manager, or resume
// database. Spawn each Work in a fresh process; physical cwd is Host-supplied.
export const createGeminiCliLauncher = ({ command = 'gemini', args = [], timeoutMs = 55000,
  runProcess = spawnSync } = {}) => (request) => {
  const startedAt = Date.now();
  const child = runProcess(command, [
    ...args, '--prompt', request.message, '--output-format', 'json', '--skip-trust',
    '--approval-mode', request.readOnly ? 'plan' : 'auto_edit',
    ...(request.model ? ['--model', request.model] : []),
  ], {
    cwd: request.workingDirectory || process.cwd(),
    env: request.environment ? { ...process.env, ...request.environment } : process.env,
    encoding: 'utf8', shell: false, windowsHide: true,
    timeout: Math.min(timeoutMs, 55000), maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error) return {
    status: 'blocked', errorCode: child.error.code || 'gemini_cli_launch_failed',
    errorSummary: sanitizePersistentText(String(child.error.message)),
    wallClockMs: Date.now() - startedAt,
  };
  const result = parseGeminiCliResult(String(child.stdout || ''), { review: request.readOnly });
  if (child.status !== 0 && result.status === 'completed') return {
    status: 'failed', errorCode: 'gemini_cli_exit_failed', wallClockMs: Date.now() - startedAt,
  };
  return { ...result, wallClockMs: Date.now() - startedAt };
};
