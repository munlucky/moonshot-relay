#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadStandaloneCatalog, standaloneEntry } from '../scripts/kernel/standalone/catalog.mjs';
import { parseCliArgs, printResult } from '../scripts/kernel/standalone/common.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runStandaloneCli(name, argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env } = {}) {
  const catalog = await loadStandaloneCatalog({ repoRoot, validateSources: true });
  const entry = standaloneEntry(catalog, name);
  if (!entry) throw Object.assign(new Error(`UNKNOWN_STANDALONE: ${name}`), { code: 'UNKNOWN_STANDALONE' });
  if (!entry.cli?.enabled) throw Object.assign(new Error(`CLI_DISABLED: ${name}`), { code: 'CLI_DISABLED' });
  const exportName = entry.exportName;
  const implementation = await import(pathToFileURL(path.resolve(repoRoot, entry.entrypoint)).href);
  if (typeof implementation[exportName] !== 'function') {
    throw Object.assign(new Error(`ENTRYPOINT_EXPORT_MISSING: ${entry.entrypoint}#${exportName}`), { code: 'ENTRYPOINT_EXPORT_MISSING' });
  }
  const args = parseCliArgs(argv);
  const result = await implementation[exportName]({
    cwd,
    env,
    command: args._[0] || 'status',
    args: { ...args, provider: args.provider || 'codex,claude' },
    query: args.query || '',
    force: args.force === true,
    message: args.message || null,
    push: args.push === true,
    memory: args.memory === true,
    memoryReview: args.memoryReview === true,
    approvalRef: args.approvalRef || null,
    runId: args.runId || null,
    output: args.output || null,
    target: args.target || args.path || null,
    objective: args.objective || args._.slice(0).join(' '),
    source: args.source || null,
    approve: args.approve === true,
    approver: args.approver || null,
    reason: args.reason || args.approvalReason || null,
    operatorApprovalRef: args.operatorApprovalRef || env.MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF || null,
  });
  return { ...result, utility: name, authority: entry.authority || 'informational' };
}

const invokedName = () => {
  const explicit = process.argv[2] === '--utility' ? process.argv[3] : null;
  if (explicit) return { name: explicit, argv: process.argv.slice(4) };
  const envName = process.env.MOON_RELAY_STANDALONE_NAME;
  if (envName) return { name: envName, argv: process.argv.slice(2) };
  const basename = path.basename(process.argv[1] || '').replace(/\.(?:cmd|ps1|mjs)$/i, '');
  return { name: basename, argv: process.argv.slice(2) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { name, argv } = invokedName();
  runStandaloneCli(name, argv)
    .then((result) => printResult(result, { json: argv.includes('--json') }))
    .catch((error) => {
      printResult({ status: 'error', errorCode: error.code || error.message, findings: error.findings || undefined }, { json: true });
      process.exitCode = 1;
    });
}
