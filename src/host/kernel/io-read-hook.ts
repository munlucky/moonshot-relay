import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectIoPath, relativeIoFile } from './io-common.js';

export interface ReadHookInput {
  tool_name?: string;
  tool_input?: { command?: string; cmd?: string; path?: string; file_path?: string; offset?: unknown; limit?: unknown };
  cwd?: string;
}

// Deliberately recognize only one plain full-file read. Pipelines, shell
// expressions, range reads and searches stay with the ordinary Codex tools.
export function fullReadPath(input: ReadHookInput): string | null {
  const args = input.tool_input;
  if (!args) return null;
  if (input.tool_name === 'Read') return args.offset === undefined && args.limit === undefined
    ? args.file_path || args.path || null : null;
  if (!['Bash', 'exec_command'].includes(input.tool_name || '')) return null;
  const command = args.command || args.cmd || '';
  if (/[\r\n;|&$`<>]/.test(command)) return null;
  const tokens = command.trim().match(/'(?:[^']|'')*'|"[^"]*"|[^\s]+/g) || [];
  const reader = tokens.shift()?.toLowerCase();
  if (!reader || !['get-content', 'cat'].includes(reader)) return null;
  let file: string | null = null;
  for (const token of tokens) {
    if (reader === 'get-content' && /^-(raw|literalpath|path)$/i.test(token)) continue;
    if (token.startsWith('-') || file !== null) return null;
    file = /^(['"]).*\1$/.test(token) ? token.slice(1, -1).replaceAll("''", "'") : token;
  }
  return file;
}

export async function evaluateReadHook(input: ReadHookInput, options: {
  runtimeHome: string; minLines: number; env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  const { runtimeHome, minLines, env = process.env } = options;
  try {
    if (!Number.isSafeInteger(minLines) || minLines <= 0 || !input.cwd) return {};
    const value = fullReadPath(input);
    if (!value) return {};
    const root = await realpath(input.cwd);
    const relative = relativeIoFile(path.relative(root, path.resolve(root, value)).split(path.sep).join('/'));
    const file = await inspectIoPath(root, relative, true);
    const command = path.join(runtimeHome, 'bin', 'moonshot-io.mjs');
    await access(command);
    // Do not block the ordinary tool when the installed Reader has no local
    // auth material. Expiration/service failures still require the E2E probe.
    if (!env.OPENAI_API_KEY) {
      const auth = JSON.parse(await readFile(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'));
      if (!auth.tokens && !auth.OPENAI_API_KEY) return {};
    }
    const size = (await stat(file)).size;
    // Files outside the bounded Reader input are never trapped by this hook.
    const maxInputBytes = 1024 * 1024;
    if (size >= maxInputBytes - 8192) return {};
    const content = await readFile(file, 'utf8');
    const lines = content ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0;
    if (lines <= minLines) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Use the installed Reader for this full-file read. Pipe a JSON request '
        + JSON.stringify({ question: 'Replace with your exact question', references: [relative], maxInputBytes, maxOutputBytes: 12000, timeoutMs: 120000 })
        + ` to node "${command}" io-read - from the same working directory. `
        + 'Check conditions and uncertainty in the answer. Sources identify supplied snapshots, not verified claims. Small reads, rg, and exact ranges remain available. '
        + 'If Reader execution fails, report the error and use a bounded source read; do not repeatedly invoke the full read.' } };
  } catch { return {}; }
}
