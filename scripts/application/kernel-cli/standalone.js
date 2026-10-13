// Generated from src/application/kernel-cli/standalone.ts. Edit the source and run npm run build.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStandaloneCatalog, standaloneEntry } from '../../kernel/standalone/catalog.js';
import { parseCliArgs, resolveStandaloneProject } from '../../kernel/standalone/common.js';
import { observeWorkspaceIdentity } from '../../host/kernel/workspace/workspace-identity.js';
import { diagnoseKernelRecovery } from '../../host/kernel/run/agent-recovery.js';
const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {});
export async function runStandaloneCliApplication(name, argv = [], { cwd = '.', env = {}, runtimeRoot = null, } = {}) {
    if (!runtimeRoot) {
        throw Object.assign(new Error('standalone_runtime_root_required'), { code: 'standalone_runtime_root_required' });
    }
    const catalog = await loadStandaloneCatalog({
        repoRoot: runtimeRoot,
        validateSources: true,
    });
    const entry = standaloneEntry(catalog, name);
    if (!entry) {
        throw Object.assign(new Error(`UNKNOWN_STANDALONE: ${name}`), { code: 'UNKNOWN_STANDALONE' });
    }
    if (!entry.cli?.enabled) {
        throw Object.assign(new Error(`CLI_DISABLED: ${name}`), { code: 'CLI_DISABLED' });
    }
    const exportName = entry.exportName;
    const moduleValue = await import(pathToFileURL(path.resolve(runtimeRoot, entry.entrypoint)).href);
    const implementation = asRecord(moduleValue);
    const exported = implementation[exportName];
    if (typeof exported !== 'function') {
        throw Object.assign(new Error(`ENTRYPOINT_EXPORT_MISSING: ${entry.entrypoint}#${exportName}`), { code: 'ENTRYPOINT_EXPORT_MISSING' });
    }
    const args = parseCliArgs(argv);
    let result;
    try {
        result = await exported({
            cwd,
            env,
            command: args._[0] || 'status',
            args: { ...args, provider: args.provider || 'codex,claude' },
            query: args.query || '',
            force: args.force === true,
            message: args.message || null,
            messageFile: args.messageFile ?? null,
            initialPathsFile: args.initialPathsJson ?? null,
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
    }
    catch (error) {
        const failure = asRecord(error);
        try {
            const project = resolveStandaloneProject({ cwd, env });
            failure.recovery = diagnoseKernelRecovery({ projectRoot: project.projectRoot, runtimeHome: project.runtimeHome,
                runId: typeof args.runId === 'string' ? args.runId : env.MOON_RELAY_KERNEL_RUN_ID || null,
                sessionId: env.MOON_RELAY_KERNEL_SESSION_ID || (env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}` : null),
                failure, env }).recovery;
        }
        catch { /* Preserve the original failure when the project cannot be resolved. */ }
        throw error;
    }
    return {
        ...asRecord(result),
        utility: name,
        authority: entry.authority || 'informational',
    };
}
