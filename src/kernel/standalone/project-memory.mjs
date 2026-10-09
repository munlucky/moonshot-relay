#!/usr/bin/env node
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openKernelStateStore } from '../state-store.mjs';
import { resolveKernelProjectIdentity } from '../project-identity.mjs';
import { buildCodebaseIndex } from '../codebase/build-index.mjs';
import { extractCodebaseCandidates, extractSessionCandidates } from '../knowledge-ingestion/candidate-extract.mjs';
import { deduplicateCandidates } from '../knowledge-ingestion/deduplicate.mjs';
import { detectCandidateConflicts } from '../knowledge-ingestion/conflict.mjs';
import { verifyCandidates } from '../knowledge-ingestion/verify.mjs';
import { normalizeSourceReceipt, normalizeSession } from '../knowledge-ingestion/normalize.mjs';
import { providerFor } from './session-providers/index.mjs';
import { buildCodebaseManifest } from '../codebase/manifest.mjs';
import { parseCliArgs, listArg, printResult, readJson, resolveStandaloneProject, writeJsonAtomic } from './common.mjs';
import { ensureAccountRootTrack } from '../runtime-home.mjs';

const normalizeRemote = (value) => String(value || '').replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();

export function mapSessionToProject(session, project) {
  if (session.projectId && session.projectId === project.projectId) return 'matched';
  const cwd = session.workingDirectory ? path.resolve(session.workingDirectory) : null;
  const root = path.resolve(project.projectRoot);
  if (cwd && (cwd === root || cwd.startsWith(`${root}${path.sep}`))) return 'matched';
  const remote = normalizeRemote(session.remote);
  if (remote && project.aliases?.some((alias) => normalizeRemote(alias) === remote)) return cwd ? 'ambiguous' : 'matched';
  if (cwd || remote) return 'foreign';
  return 'unresolved';
}

async function discoverAllSessions({ providers = ['codex', 'claude'], since = null, limit = 50, env = process.env } = {}) {
  const results = [];
  for (const provider of providers) {
    const adapter = providerFor(provider);
    if (!adapter) { results.push({ provider, status: 'unavailable', sessions: [] }); continue; }
    results.push(await adapter.discoverSessions({ since, limit, env }));
  }
  return results;
}

export async function discoverProjectSessions({ project, providers = ['codex', 'claude'], since = null, limit = 50, env = process.env } = {}) {
  const discovered = await discoverAllSessions({ providers, since, limit, env });
  const sessions = discovered.flatMap((result) => result.sessions.map((session) => ({ ...session, mapping: mapSessionToProject(session, project) })));
  return { providers: discovered.map(({ provider, status, resolution }) => ({ provider, status, resolution })), sessions: sessions.filter((session) => session.mapping !== 'foreign') };
}

async function snapshotImport({ project, stateStore, sourceReceipt, candidates, kind }) {
  const sourceFile = path.join(project.importsRoot, 'sources', `${sourceReceipt.sourceDigest.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
  const payload = { schemaVersion: 1, kind, projectId: project.projectId, sourceReceipt, candidateCount: candidates.length, candidates, createdAt: new Date().toISOString() };
  await writeJsonAtomic(sourceFile, payload);
  const importRecord = stateStore.createKnowledgeImport({ projectId: project.projectId, sourceType: sourceReceipt.sourceType, sourceIdentity: sourceReceipt.sourceIdentity, sourceDigest: sourceReceipt.sourceDigest, sourceSnapshotRef: path.relative(project.projectRuntimeRoot, sourceFile).replaceAll('\\', '/'), status: 'awaiting_review', candidateCount: candidates.length });
  return { sourceFile, sourceSnapshotRef: importRecord.sourceSnapshotRef, importId: importRecord.importId };
}

export async function analyzeSessions({ project, stateStore, providers = ['codex', 'claude'], sessionIds = [], since = null, limit = 50, env = process.env } = {}) {
  const discovered = await discoverProjectSessions({ project, providers, since, limit, env });
  const wanted = new Set(sessionIds.map(String));
  const selected = discovered.sessions.filter((session) => (wanted.size === 0 || wanted.has(session.nativeSessionId) || wanted.has(`${session.provider}:${session.nativeSessionId}`)) && session.mapping === 'matched');
  const analyzed = [];
  for (const session of selected) {
    const adapter = providerFor(session.provider);
    const raw = await adapter.readSession(session.nativeSessionId, { locator: session.locator, env });
    const normalized = normalizeSession(raw.parsed || {}, { provider: session.provider, nativeSessionId: session.nativeSessionId, locator: session.locator });
    const sourceReceipt = normalizeSourceReceipt({ sourceType: `${session.provider}_session`, provider: session.provider, sourceIdentity: `${session.provider}:${session.nativeSessionId}`, sourceDigest: session.sourceDigest, sourceSnapshotRef: session.locator });
    let candidates = extractSessionCandidates({ ...normalized, sourceDigest: sourceReceipt.sourceDigest }, { projectId: project.projectId, sourceType: sourceReceipt.sourceType, sourceIdentity: sourceReceipt.sourceIdentity, sourceDigest: sourceReceipt.sourceDigest });
    candidates = verifyCandidates(deduplicateCandidates(candidates), { projectRoot: project.projectRoot, sourceType: sourceReceipt.sourceType });
    const snapshot = await snapshotImport({ project, stateStore, sourceReceipt, candidates, kind: 'session' });
    analyzed.push({ ...session, sourceReceipt, candidateCount: candidates.length, ...snapshot });
  }
  return { status: 'analyzed', projectId: project.projectId, discovered: discovered.sessions.length, selected: selected.length, analyzed, ambiguous: discovered.sessions.filter((session) => session.mapping === 'ambiguous'), unresolved: discovered.sessions.filter((session) => session.mapping === 'unresolved') };
}

export async function analyzeCodebase({ project, stateStore, force = false } = {}) {
  const indexResult = await buildCodebaseIndex({ projectRoot: project.projectRoot, projectId: project.projectId, codebaseRoot: project.codebaseRoot, runtimeHome: project.runtimeHome, force });
  const map = await readJson(path.join(project.codebaseRoot, 'codebase-map.json'), { files: [] });
  const sourceDigest = indexResult.manifest?.sourceTreeDigest || map.sourceTreeDigest;
  const sourceReceipt = normalizeSourceReceipt({ sourceType: 'codebase_index', sourceIdentity: `codebase:${project.projectId}`, sourceDigest, sourceSnapshotRef: 'codebase/codebase-map.json' });
  const candidates = verifyCandidates(extractCodebaseCandidates(map, { projectId: project.projectId, sourceDigest }), { projectRoot: project.projectRoot, sourceType: 'codebase_index' });
  const snapshot = await snapshotImport({ project, stateStore, sourceReceipt, candidates, kind: 'codebase' });
  return { status: indexResult.status === 'cache_hit' ? 'cache_hit' : 'analyzed', projectId: project.projectId, index: indexResult, candidateCount: candidates.length, ...snapshot };
}

export async function reviewImport({ project, stateStore, sourceFile, candidateIds = [] } = {}) {
  const snapshot = await readJson(sourceFile, null);
  if (!snapshot || snapshot.projectId !== project.projectId) throw new Error('PROJECT_ID_MISMATCH');
  const existing = stateStore.listKnowledgeRecords({ projectId: project.projectId, statuses: ['verified', 'committed'] });
  const candidates = verifyCandidates(snapshot.candidates || [], { projectRoot: project.projectRoot, sourceType: snapshot.sourceReceipt?.sourceType });
  const conflicts = detectCandidateConflicts(candidates, existing);
  const wanted = new Set(candidateIds.map(String));
  return { status: 'awaiting_review', importId: snapshot.importId || null, projectId: project.projectId, candidates: candidates.map((candidate) => ({ ...candidate, selected: wanted.size === 0 ? false : wanted.has(candidate.candidateId), conflict: conflicts.find((item) => item.candidateId === candidate.candidateId) || null })), conflicts, existingCount: existing.length };
}

export async function importSelected({ project, stateStore, sourceFile, candidateIds, approvalRef } = {}) {
  if (!approvalRef) throw new Error('USER_APPROVAL_REQUIRED: --approval-ref is required');
  const snapshot = await readJson(sourceFile, null);
  if (!snapshot || snapshot.projectId !== project.projectId) throw new Error('PROJECT_ID_MISMATCH');
  const wanted = new Set(listArg(candidateIds));
  const candidates = (snapshot.candidates || []).filter((candidate) => wanted.has(candidate.candidateId)).map((candidate) => ({ ...candidate, selected: true }));
  if (candidates.length === 0) return { status: 'no_op', reason: 'no_candidates_selected', projectId: project.projectId };
  // Standalone project-memory may prepare and select candidates, but it does
  // not write Kernel knowledge. The explicit approval is preserved as a
  // handoff receipt for the Kernel closeout path; only Kernel authority may
  // verify, commit, or supersede project knowledge.
  const handoffPath = path.join(project.importsRoot, 'kernel-handoffs', `${snapshot.importId || Date.now()}.json`);
  await writeJsonAtomic(handoffPath, {
    schemaVersion: 1,
    kind: 'KERNEL_KNOWLEDGE_HANDOFF',
    authority: 'standalone-candidate-only',
    projectId: project.projectId,
    sourceReceipt: snapshot.sourceReceipt || null,
    approvalRef,
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    candidates,
    createdAt: new Date().toISOString(),
  });
  return {
    status: 'candidate_ready_for_kernel_closeout',
    projectId: project.projectId,
    candidateCount: candidates.length,
    handoffPath: path.relative(project.projectRuntimeRoot, handoffPath).replaceAll('\\', '/'),
    authority: 'standalone-candidate-only',
    kernelActionRequired: 'kernel report or kernel-commit after accepted completion',
  };
}

export async function projectMemoryStatus({ project, stateStore } = {}) {
  const imports = stateStore.listKnowledgeImports({ projectId: project.projectId });
  const records = stateStore.listKnowledgeRecords({ projectId: project.projectId, statuses: ['observed', 'staged', 'verified', 'committed', 'superseded', 'rejected', 'archived', 'quarantined'] });
  const manifest = await readJson(path.join(project.codebaseRoot, 'index-manifest.json'), null);
  return { status: 'ready', projectId: project.projectId, projectRoot: project.projectRoot, knowledgeRevision: stateStore.getProjectKnowledgeRevision(project.projectId), imports, recordCount: records.length, codebaseIndex: manifest ? { ...manifest, freshness: manifest.sourceTreeDigest ? 'indexed' : 'stale' } : { status: 'missing' } };
}

export async function runProjectMemory({ command = 'status', args = {}, cwd = process.cwd(), env = process.env } = {}) {
  await ensureAccountRootTrack({ startDir: cwd, track: 'kernel', env, source: 'standalone-project-memory' });
  const project = resolveStandaloneProject({ cwd, env });
  const stateStore = await openKernelStateStore({ runtimeHome: project.runtimeHome });
  try {
    if (command === 'sessions') return { ...(await discoverProjectSessions({ project, providers: listArg(args.provider || 'codex,claude'), since: args.since || null, limit: Number(args.limit || 50), env })), projectId: project.projectId };
    if (command === 'codebase') return analyzeCodebase({ project, stateStore, force: args.force === true });
    if (command === 'review') return reviewImport({ project, stateStore, sourceFile: args.sourceFile, candidateIds: listArg(args.candidate || '') });
    if (command === 'import') return importSelected({ project, stateStore, sourceFile: args.sourceFile, candidateIds: args.candidate || '', approvalRef: args.approvalRef });
    if (command === 'status') return projectMemoryStatus({ project, stateStore });
    throw new Error(`unknown_project_memory_command: ${command}`);
  } finally { await stateStore.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args._[0] || 'status';
  runProjectMemory({ command, args: { ...args, provider: args.provider || 'codex,claude' } }).then((result) => printResult(result, { json: args.json })).catch((error) => { printResult({ status: 'error', errorCode: error.code || error.message }, { json: true }); process.exitCode = 1; });
}
