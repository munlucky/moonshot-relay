import { randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { denyIo, relativeIoFile, type HostIoOptions } from './io-common.js';
import { createStandaloneIo } from './io-standalone.js';

interface WriterHookInput {
  hook_event_name?: string;
  permission_mode?: string;
  cwd?: string;
  prompt?: string;
}

const budgets = { maxInputBytes: 240_000, maxOutputBytes: 20_000, timeoutMs: 120_000 };

function context(additionalContext: string) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
}

function applyCommand(runtimeHome: string, metadata: string) {
  const args = [process.execPath, path.join(runtimeHome, 'bin', 'moonshot-io.mjs'), 'io-apply', metadata];
  if (process.platform === 'win32') {
    return 'PowerShell command: & ' + args.map(value => "'" + value.replaceAll('\\', '/').replaceAll("'", "''") + "'").join(' ');
  }
  return 'Shell command: ' + args.map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
}

export async function evaluateWriteHook(input: WriterHookInput, options: Omit<HostIoOptions, 'projectRoot'>): Promise<{
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}> {
  if (input.hook_event_name !== 'UserPromptSubmit' || typeof input.prompt !== 'string') return {};
  const selection = /^Writer: ([^\r\n]+)\r?\nReferences: ([^\r\n]+)\r?\n\r?\n([\s\S]+)$/u.exec(input.prompt.trim());
  if (!selection) return {};
  const reportFailure = (code: string) => context(
    'The explicitly requested Writer did not prepare an applicable candidate. Report this status: ' + code + '.');
  // The hook runs before the normal tool permission check. Use it only in
  // the full-access permission mode. Project writes still go through a tool.
  if (input.permission_mode !== 'bypassPermissions') return reportFailure('writer_hook_permission_mode_unsupported');
  try {
    if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) denyIo('host_io_workspace_required');
    const projectRoot = await realpath(input.cwd);
    const filePath = relativeIoFile(selection[1]!);
    const references = selection[2]!.split(', ').map(relativeIoFile);
    const specification = selection[3]!;
    if (references.some(file => file.toLowerCase() === filePath.toLowerCase())) denyIo('host_io_path_invalid');
    if (Buffer.byteLength(specification) >= budgets.maxInputBytes) denyIo('host_io_input_budget_exceeded');
    const candidate = await createStandaloneIo({ ...options, projectRoot }).write({ ...budgets, filePath, references, specification });
    if (candidate.status !== 'generated' || !('candidatePath' in candidate) || !candidate.candidateRoot) {
      return reportFailure('failureCode' in candidate ? candidate.failureCode : 'host_io_generation_failed');
    }
    const metadata = path.join(candidate.candidateRoot, 'apply-' + randomUUID() + '.json');
    await writeFile(metadata, JSON.stringify(candidate), { flag: 'wx' });
    return context('Luna generated an isolated candidate for the explicitly requested new file. '
      + 'Apply it once using the ordinary shell tool from the current project directory and report the actual result. '
      + 'If apply fails, report its status. ' + applyCommand(options.runtimeHome, metadata));
  } catch (error) {
    return reportFailure((error as NodeJS.ErrnoException).code || 'writer_hook_failed');
  }
}
