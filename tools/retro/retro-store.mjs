import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveKernelRuntimeHome } from '../../scripts/kernel/runtime-home.js';
import { assertSafeRetroPayload, validateCollectRecord, validateDate, validateRetroIdentifier } from './retro-normalize.mjs';

export function resolveRetroRoot({ projectId, stateRoot, env = process.env } = {}) {
  if (!projectId) throw new Error('--project is required');
  validateRetroIdentifier(projectId, 'projectId');
  if (stateRoot) return path.resolve(stateRoot);
  const home = resolveKernelRuntimeHome({ env });
  return path.join(home, 'state', 'projects', projectId, 'retro');
}

export function defaultOutboxRoot({ date, cwd = process.cwd() } = {}) {
  validateDate(date);
  return path.join(cwd, '.moonshot-relay', 'retro-outbox', date);
}

export async function listCollectFiles({ source }) {
  const root = path.resolve(source);
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.collect.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export async function readCollectRecord(filePath) {
  const payload = JSON.parse(await readFile(filePath, 'utf8'));
  return validateCollectRecord(payload);
}

export async function writeCollectRecord({ record, outRoot, replace = false }) {
  validateCollectRecord(record);
  const root = path.resolve(outRoot || defaultOutboxRoot({ date: record.date }));
  await mkdir(root, { recursive: true });
  const target = containedFile(root, `${record.taskId}.collect.json`);
  if (existsSync(target) && !replace) {
    throw new Error(`collect record already exists: ${target}. Use --replace to overwrite.`);
  }
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`);
  return target;
}

export async function importCollectRecords({ projectId, date, source, stateRoot }) {
  validateDate(date);
  const files = await listCollectFiles({ source });
  const retroRoot = resolveRetroRoot({ projectId, stateRoot });
  const inboxRoot = path.join(retroRoot, 'inbox', date);
  await mkdir(inboxRoot, { recursive: true });
  const seenTaskIds = new Set();
  let imported = 0;
  let skippedDuplicates = 0;
  let rejected = 0;

  for (const file of files) {
    try {
      const record = await readCollectRecord(file);
      assertSafeRetroPayload(record);
      if (record.projectId !== projectId || record.date !== date) {
        rejected += 1;
        continue;
      }
      const target = containedFile(inboxRoot, `${record.taskId}.collect.json`);
      if (seenTaskIds.has(record.taskId) || existsSync(target)) {
        skippedDuplicates += 1;
        continue;
      }
      await writeFile(target, `${JSON.stringify(record, null, 2)}\n`);
      seenTaskIds.add(record.taskId);
      imported += 1;
    } catch {
      rejected += 1;
    }
  }

  const manifest = {
    schemaVersion: 'retro.import-result.v1',
    projectId,
    date,
    imported,
    skippedDuplicates,
    rejected,
    inboxRoot,
    promotionAuthority: false,
  };
  await writeFile(path.join(inboxRoot, 'import-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function containedFile(root, fileName) {
  const target = path.resolve(root, fileName);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && target.startsWith(`${normalizedRoot}${path.sep}`)) return target;
  throw new Error(`retro target escapes root: ${fileName}`);
}

export async function readInboxRecords({ projectId, date, stateRoot }) {
  const retroRoot = resolveRetroRoot({ projectId, stateRoot });
  const inboxRoot = path.join(retroRoot, 'inbox', date);
  if (!existsSync(inboxRoot)) return [];
  const entries = await readdir(inboxRoot, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.collect.json'))
    .map((entry) => path.join(inboxRoot, entry.name))
    .sort();
  return Promise.all(files.map(readCollectRecord));
}

export async function writeDailyArtifacts({ projectId, date, payload, markdown, stateRoot }) {
  const root = path.join(resolveRetroRoot({ projectId, stateRoot }), 'daily', date);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'daily-retro.json'), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(path.join(root, 'daily-retro.md'), `${markdown}\n`);
  await writeFile(path.join(root, 'improvement-candidates.json'), `${JSON.stringify({
    schemaVersion: 'retro.improvement-candidates.v1',
    projectId,
    date,
    candidates: payload.improvementCandidates,
    promotionAuthority: false,
  }, null, 2)}\n`);
  return root;
}
