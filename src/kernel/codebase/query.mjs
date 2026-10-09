import { readFile } from 'node:fs/promises';

export async function queryCodebaseIndex({ codebaseRoot, query = '', limit = 50 } = {}) {
  const map = JSON.parse(await readFile(`${codebaseRoot}/codebase-map.json`, 'utf8'));
  const needle = String(query || '').toLowerCase();
  const files = (map.files || []).filter((file) => !needle || JSON.stringify(file).toLowerCase().includes(needle)).slice(0, Number(limit) || 50);
  return { status: 'ready', projectId: map.projectId, sourceTreeDigest: map.sourceTreeDigest, query: needle, files };
}
