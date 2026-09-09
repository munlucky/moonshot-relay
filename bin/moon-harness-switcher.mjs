#!/usr/bin/env node
import process from 'node:process';
import { switchStatus, switchDoctor, launchSwitch, recoverSwitch, rollbackSwitch, uninstallSwitcher, cleanupLegacyProject } from '../scripts/switcher/operations.mjs';
import { buildLivePreflight, adoptLive } from '../scripts/switcher/adoption.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'status';
const get = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const json = args.includes('--json');
const output = (value) => console.log(json ? JSON.stringify(value) : Object.entries(value || {}).map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n'));

import { resolveCodexDesktop } from '../scripts/switcher/app-resolver/codex.mjs';

const normalizeSurface = async (s) => {
  if (!s || s === 'all') return 'all';
  if (s === 'codex') {
    const desktop = await resolveCodexDesktop();
    return desktop.executable ? 'codex_desktop' : 'codex_cli';
  }
  if (s === 'codex_desktop' || s === 'codex-desktop' || s === 'codex-app') return 'codex_desktop';
  if (s === 'codex_cli' || s === 'codex-cli') return 'codex_cli';
  if (s === 'claude_desktop' || s === 'claude-desktop' || s === 'claude-app') return 'claude_desktop';
  if (s === 'claude' || s === 'claude_cli' || s === 'claude-cli' || s === 'claude-code') return 'claude_cli';
  if (s === 'qwen' || s === 'qwen_cli' || s === 'qwen-cli') return 'qwen_cli';
  if (s === 'ade' || s === 'ade_cli' || s === 'ade-cli') return 'ade_cli';
  if (s === 'antigravity' || s === 'antigravity_desktop' || s === 'antigravity-desktop' || s === 'agy') return 'antigravity_desktop';
  return s;
};

try {
  const rawSurface = get('--surface');
  const surface = await normalizeSurface(rawSurface);
  const requestedRuntime = get('--track');
  if (requestedRuntime && requestedRuntime !== 'kernel' && requestedRuntime !== 'relay') {
    throw Object.assign(new Error('wrong_harness: unsupported runtime selector ' + requestedRuntime), { code: 'wrong_harness' });
  }
  if (requestedRuntime === 'relay') {
    const retired = { schemaVersion: 1, status: 'retired', runtime: 'moon-relay-kernel', errorCode: 'relay_track_retired', message: 'Relay runtime track is retired; launch Kernel directly.', sensitiveContentRead: false };
    output(retired);
    process.exitCode = 1;
    throw Object.assign(new Error(retired.message), { code: retired.errorCode, alreadyOutput: true });
  }
  let result;
  if (command === 'status') result = await switchStatus({ surface: surface === 'all' ? null : surface });
  else if (command === 'doctor') result = await switchDoctor({ surface: surface === 'all' ? null : surface });
  else if (command === 'preflight') result = await buildLivePreflight({ sourceRoot: get('--source-root') || process.cwd(), kernelHome: get('--kernel-home') || undefined });
  else if (command === 'adopt') result = await adoptLive({ sourceRoot: get('--source-root') || process.cwd(), kernelHome: get('--kernel-home') || undefined, approved: args.includes('--approved'), approvalToken: get('--approval-token') || '' });
  else if (command === 'cleanup-project') {
    result = await cleanupLegacyProject({
      projectRoot: get('--project-root') || process.cwd(),
      providerHome: get('--provider-home'),
    });
  }
  else if (command === 'launch') {
    const targets = surface === 'all'
      ? ['codex_desktop', 'claude_desktop', 'claude_cli', 'qwen_cli', ...(process.env.ADE_HOME ? ['ade_cli'] : []), 'antigravity_desktop']
      : [surface];
    const results = [];
    const taskBinding = {
      runId: get('--run-id'),
      projectId: get('--project-id'),
      sessionId: get('--session-id'),
      workspaceId: get('--workspace-id'),
    };
    for (const item of targets) {
      const res = await launchSwitch({
        surface: item,
        sourceRoot: get('--source-root') || process.cwd(),
        projectRoot: get('--project-root') || process.cwd(),
        taskBinding,
        dryRun: !args.includes('--execute'),
        force: args.includes('--force') || args.includes('-f'),
      });
      results.push(res);
    }
    result = targets.length === 1 ? results[0] : { schemaVersion: 1, status: 'completed', operation: 'launch', runtime: 'moon-relay-kernel', results };
  }
  else if (command === 'recover') result = await recoverSwitch({ surface: surface === 'all' ? null : surface, closeApproval: args.includes('--approved') });
  else if (command === 'rollback') result = await rollbackSwitch({ surface: surface === 'all' ? null : surface });
  else if (command === 'uninstall') result = await uninstallSwitcher({ home: get('--home') });
  else throw new Error(`unknown command: ${command}`);
  output(result);
  if (command === 'launch') {
    const launches = result?.results || [result];
    if (launches.some((item) => !['committed', 'already_effective'].includes(item?.status))) process.exitCode = 1;
  } else if (result?.status === 'error' || result?.status === 'unsafe_target' || result?.errorCode === 'wrong_harness' || result?.errorCode === 'unsafe_target') process.exitCode = 1;
} catch (error) {
  if (!error.alreadyOutput) output({ schemaVersion: 1, status: 'error', errorCode: error.code || 'unknown_error', message: error.message, sensitiveContentRead: false });
  process.exitCode = 1;
}
