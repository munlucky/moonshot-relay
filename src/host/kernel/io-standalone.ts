import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertIoBudgets, assertIoReferencesFresh, denyIo, inspectIoPath, ioDigest,
  readIoReferences, relativeIoFile, type HostIoOptions, type IoContext, type IoRequest } from './io-common.js';
import { createIoReader } from './io-reader.js';
import { createIoWriter } from './io-writer.js';

export interface StandaloneIoRequest {
  references: string[];
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

function assertStandalone(request: StandaloneIoRequest) {
  if (!request || ['runId', 'stepId', 'expectedWorkspaceIdentity'].some(key => key in request)) {
    denyIo('standalone_io_kernel_request_rejected');
  }
  if (!Array.isArray(request.references) || !request.references.length) denyIo('host_io_reference_required');
}

async function workspaceContext(projectRoot: string, filePath?: string): Promise<IoContext> {
  const root = await realpath(projectRoot);
  return { root, forbidden: [], allowedPaths: filePath ? [relativeIoFile(filePath)] : [], requestKey: [],
    async assertFresh() {
      if (await realpath(projectRoot) !== root || !(await lstat(root)).isDirectory()) denyIo('host_io_workspace_changed');
    } };
}

// Only this explicit entrypoint acquires local workspace authority. Kernel MCP
// still calls bindIoWorkUnit; it never falls back here on an authority failure.
export function createStandaloneIo(options: HostIoOptions) {
  const read = createIoReader(options), write = createIoWriter(options);
  async function prepare(request: StandaloneIoRequest, filePath?: string) {
    assertStandalone(request);
    assertIoBudgets({ ...request, references: [] });
    const context = await workspaceContext(options.projectRoot, filePath);
    let remaining = request.maxInputBytes;
    const references: IoRequest['references'] = [];
    for (const value of request.references) {
      const relative = relativeIoFile(value);
      const full = await inspectIoPath(context.root, relative, true);
      if ((await lstat(full)).size > remaining) denyIo('host_io_input_budget_exceeded');
      const bytes = await readFile(full);
      remaining -= bytes.length;
      if (remaining < 0) denyIo('host_io_input_budget_exceeded');
      references.push({ path: relative, sha256: ioDigest(bytes) });
    }
    context.requestKey = references;
    await context.assertFresh();
    return { context, references };
  }
  return {
    async read(request: StandaloneIoRequest & { question: string }) {
      const { context, references } = await prepare(request);
      return read({ ...request, references }, async () => context);
    },
    async write(request: StandaloneIoRequest & { filePath: string; specification: string }) {
      const { context, references } = await prepare(request, request.filePath);
      const result = await write({ ...request, references }, async () => context);
      return { ...result, projectRoot: context.root, references };
    },
  };
}

export interface StandaloneIoCandidate {
  status: string;
  projectRoot: string;
  references: IoRequest['references'];
  filePath: string;
  candidatePath: string;
  sha256: string;
  bytes: number;
}

// Invoked explicitly through the ordinary Codex shell tool after candidate
// inspection. wx protects the new destination, not a multi-file transaction.
export async function applyStandaloneIoCandidate(projectRoot: string, candidate: StandaloneIoCandidate) {
  const context = await workspaceContext(projectRoot, candidate.filePath);
  const filePath = relativeIoFile(candidate.filePath);
  if (candidate.status !== 'generated' || candidate.projectRoot !== context.root
    || !path.isAbsolute(candidate.candidatePath) || !Array.isArray(candidate.references)
    || !candidate.references.length || !Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0) {
    denyIo('host_io_candidate_invalid');
  }
  const candidateVolume = path.parse(candidate.candidatePath).root;
  const candidateRelative = path.relative(candidateVolume, candidate.candidatePath).split(path.sep).join('/');
  await inspectIoPath(candidateVolume, relativeIoFile(candidateRelative), true);
  const bytes = await readFile(candidate.candidatePath);
  if (bytes.length !== candidate.bytes || ioDigest(bytes) !== candidate.sha256) denyIo('host_io_candidate_tampered');
  const sources = await readIoReferences(context.root, candidate.references, [], Number.MAX_SAFE_INTEGER);
  await inspectIoPath(context.root, filePath, false);
  const target = path.join(context.root, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await context.assertFresh();
  await assertIoReferencesFresh(context.root, sources);
  await inspectIoPath(context.root, filePath, false);
  if (ioDigest(await readFile(candidate.candidatePath)) !== candidate.sha256) denyIo('host_io_candidate_tampered');
  const handle = await open(target, 'wx');
  let writeFailure: unknown;
  try { await handle.writeFile(bytes); } catch (error) { writeFailure = error; }
  try { await handle.close(); } catch (error) { writeFailure ??= error; }
  if (writeFailure) {
    let destinationState = 'unknown';
    try { destinationState = ioDigest(await readFile(target)) === candidate.sha256 ? 'created' : 'partial-or-changed'; }
    catch (inspection) { if ((inspection as NodeJS.ErrnoException).code === 'ENOENT') destinationState = 'missing'; }
    throw Object.assign(new Error('host_io_apply_write_failed'), { code: 'host_io_apply_write_failed',
      destinationState, cause: writeFailure });
  }
  if (ioDigest(await readFile(target)) !== candidate.sha256) denyIo('host_io_applied_file_changed');
  return { status: 'created', filePath, sha256: candidate.sha256, bytes: bytes.length };
}
