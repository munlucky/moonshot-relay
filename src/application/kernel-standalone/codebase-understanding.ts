#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { buildCodebaseIndex, queryCodebaseIndex } from '../../host/kernel/codebase/codebase-index.js';
import { extractCodebaseCandidates } from '../../kernel/knowledge-ingestion/candidate-extract.js';
import { parseCliArgs, printResult, readJson, resolveStandaloneProject } from '../../kernel/standalone/common.js';
import { ensureAccountRootTrack } from '../../kernel/runtime-home.js';
import { isDirectEntrypoint } from '../../shared/runtime-assets.js';

type UnknownRecord = Record<string, unknown>;

interface CodebaseUnderstandingOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  query?: string;
  force?: boolean;
}

interface CodebaseCliArgs extends UnknownRecord {
  _: string[];
  json: boolean;
  query?: string;
  force?: boolean;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export async function runCodebaseUnderstanding({
  cwd = process.cwd(),
  env = process.env,
  query = '',
  force = false,
}: CodebaseUnderstandingOptions = {}) {
  await ensureAccountRootTrack({
    startDir: cwd,
    track: 'kernel',
    env,
    source: 'standalone-codebase-understanding',
  });
  const project = resolveStandaloneProject({ cwd, env });
  const index = await buildCodebaseIndex({
    projectRoot: project.projectRoot,
    projectId: project.projectId,
    codebaseRoot: project.codebaseRoot,
    runtimeHome: project.runtimeHome,
    force,
  });
  const map = query
    ? null
    : await readJson<UnknownRecord>(
      path.join(project.codebaseRoot, 'codebase-map.json'),
      { files: [] },
    );
  const candidates = query
    ? []
    : extractCodebaseCandidates(
      map || {},
      {
        projectId: project.projectId,
        sourceDigest: index.manifest?.sourceTreeDigest,
      },
    );
  const result = query
    ? await queryCodebaseIndex({ codebaseRoot: project.codebaseRoot, query })
    : { ...index, candidateCount: candidates.length, candidates };
  return {
    ...result,
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    runtimeRoot: project.codebaseRoot,
  };
}

if (isDirectEntrypoint(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2)) as CodebaseCliArgs;
  try {
    printResult(
      await runCodebaseUnderstanding({
        query: args.query || '',
        force: args.force === true,
      }),
      { json: args.json },
    );
  } catch (error: unknown) {
    const failure = error && typeof error === 'object'
      ? error as UnknownRecord
      : {};
    printResult(
      {
        status: 'error',
        errorCode: failure.code || errorMessage(error),
      },
      { json: true },
    );
    process.exitCode = 1;
  }
}
