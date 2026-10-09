#!/usr/bin/env node
import { openKernelStateStore } from '../state-store.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCodebaseIndex } from '../codebase/build-index.mjs';
import { queryCodebaseIndex } from '../codebase/query.mjs';
import { extractCodebaseCandidates } from '../knowledge-ingestion/candidate-extract.mjs';
import { parseCliArgs, printResult, resolveStandaloneProject } from './common.mjs';
import { ensureAccountRootTrack } from '../runtime-home.mjs';

export async function runCodebaseUnderstanding({ cwd = process.cwd(), env = process.env, query = '', force = false } = {}) {
  await ensureAccountRootTrack({ startDir: cwd, track: 'kernel', env, source: 'standalone-codebase-understanding' });
  const project = resolveStandaloneProject({ cwd, env });
  const index = await buildCodebaseIndex({ projectRoot: project.projectRoot, projectId: project.projectId, codebaseRoot: project.codebaseRoot, runtimeHome: project.runtimeHome, force });
  const candidates = query ? [] : extractCodebaseCandidates(index.manifest ? JSON.parse(await (await import('node:fs/promises')).readFile(`${project.codebaseRoot}/codebase-map.json`, 'utf8')) : {}, { projectId: project.projectId, sourceDigest: index.manifest?.sourceTreeDigest });
  const result = query ? await queryCodebaseIndex({ codebaseRoot: project.codebaseRoot, query }) : { ...index, candidateCount: candidates.length, candidates };
  return { ...result, projectId: project.projectId, projectRoot: project.projectRoot, runtimeRoot: project.codebaseRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseCliArgs(process.argv.slice(2));
  try { printResult(await runCodebaseUnderstanding({ query: args.query || '', force: args.force === true }), { json: args.json }); }
  catch (error) { printResult({ status: 'error', errorCode: error.code || error.message }, { json: true }); process.exitCode = 1; }
}
