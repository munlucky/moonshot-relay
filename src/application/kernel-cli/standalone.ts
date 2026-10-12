import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStandaloneCatalog, standaloneEntry } from '../../kernel/standalone/catalog.js';
import { parseCliArgs } from '../../kernel/standalone/common.js';
import { observeWorkspaceIdentity } from '../../host/kernel/workspace/workspace-identity.js';

type CliArgValue = string | boolean | undefined;

interface StandaloneCliArgs extends Record<string, unknown> {
  _: string[];
  json: boolean;
  provider?: CliArgValue;
  query?: CliArgValue;
  force?: CliArgValue;
  message?: CliArgValue;
  messageFile?: CliArgValue;
  push?: CliArgValue;
  memory?: CliArgValue;
  memoryReview?: CliArgValue;
  approvalRef?: CliArgValue;
  runId?: CliArgValue;
  output?: CliArgValue;
  target?: CliArgValue;
  path?: CliArgValue;
  objective?: CliArgValue;
  source?: CliArgValue;
  approve?: CliArgValue;
  approver?: CliArgValue;
  reason?: CliArgValue;
  approvalReason?: CliArgValue;
  operatorApprovalRef?: CliArgValue;
}

interface StandaloneApplicationOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runtimeRoot?: string | null;
}

type StandaloneImplementation = (
  input: Record<string, unknown>,
) => Promise<unknown> | unknown;

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export async function runStandaloneCliApplication(
  name: string,
  argv: string[] = [],
  {
    cwd = '.',
    env = {},
    runtimeRoot = null,
  }: StandaloneApplicationOptions = {},
): Promise<Record<string, unknown>> {
  if (!runtimeRoot) {
    throw Object.assign(
      new Error('standalone_runtime_root_required'),
      { code: 'standalone_runtime_root_required' },
    );
  }

  const catalog = await loadStandaloneCatalog({
    repoRoot: runtimeRoot,
    validateSources: true,
  });
  const entry = standaloneEntry(catalog, name);
  if (!entry) {
    throw Object.assign(
      new Error(`UNKNOWN_STANDALONE: ${name}`),
      { code: 'UNKNOWN_STANDALONE' },
    );
  }
  if (!entry.cli?.enabled) {
    throw Object.assign(
      new Error(`CLI_DISABLED: ${name}`),
      { code: 'CLI_DISABLED' },
    );
  }

  const exportName = entry.exportName;
  const moduleValue: unknown = await import(
    pathToFileURL(path.resolve(runtimeRoot, entry.entrypoint)).href
  );
  const implementation = asRecord(moduleValue);
  const exported: unknown = implementation[exportName];
  if (typeof exported !== 'function') {
    throw Object.assign(
      new Error(`ENTRYPOINT_EXPORT_MISSING: ${entry.entrypoint}#${exportName}`),
      { code: 'ENTRYPOINT_EXPORT_MISSING' },
    );
  }

  const args = parseCliArgs(argv) as StandaloneCliArgs;
  const result = await (exported as StandaloneImplementation)({
    cwd,
    env,
    command: args._[0] || 'status',
    args: { ...args, provider: args.provider || 'codex,claude' },
    query: args.query || '',
    force: args.force === true,
    message: args.message || null,
    messageFile: args.messageFile ?? null,
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
    operatorApprovalRef: args.operatorApprovalRef
      || env.MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF
      || null,
    observeWorkspaceIdentity,
  });

  return {
    ...asRecord(result),
    utility: name,
    authority: entry.authority || 'informational',
  };
}
