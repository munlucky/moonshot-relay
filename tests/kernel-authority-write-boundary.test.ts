import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve('.');
const ownershipPath = path.join(ROOT, 'docs', 'decomplexification', 'kernel-write-ownership.json');

interface AuthorityContract {
  schemaVersion: number;
  authorities: {
    id: string; persistence: string; semanticOwner: string; persistenceSources: string[];
    tables: string[]; writeApis: string[]; tableWriters: Record<string, string[]>;
  }[];
  retiredOrForbiddenWriters: string[];
  obsoletePersistenceModules: string[];
}

const readOwnership = async (): Promise<AuthorityContract> => {
  const contract: unknown = JSON.parse(await readFile(ownershipPath, 'utf8'));
  assert.ok(contract && typeof contract === 'object' && 'schemaVersion' in contract && 'authorities' in contract);
  assert.ok(Array.isArray(contract.authorities));
  for (const value of contract.authorities as unknown[]) {
    assert.ok(value && typeof value === 'object');
    for (const key of ['id', 'persistence', 'semanticOwner']) assert.equal(typeof (value as Record<string, unknown>)[key], 'string');
    for (const key of ['persistenceSources', 'tables', 'writeApis']) {
      const entries: unknown = (value as Record<string, unknown>)[key];
      assert.ok(Array.isArray(entries) && entries.every(entry => typeof entry === 'string'));
    }
    assert.ok('tableWriters' in value && value.tableWriters && typeof value.tableWriters === 'object');
    for (const entries of Object.values(value.tableWriters)) assert.ok(Array.isArray(entries) && entries.every(entry => typeof entry === 'string'));
  }
  for (const key of ['retiredOrForbiddenWriters', 'obsoletePersistenceModules']) {
    const entries: unknown = (contract as Record<string, unknown>)[key];
    assert.ok(Array.isArray(entries) && entries.every(entry => typeof entry === 'string'));
  }
  return contract as AuthorityContract;
};

const walk = async (dir: string): Promise<string[]> => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
};

test('W-03: authority ownership contract has exactly Work, Trust, and Knowledge semantic owners', async () => {
  const contract = await readOwnership();
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.authorities.map((entry) => entry.id), ['work', 'trust', 'knowledge']);
  for (const authority of contract.authorities) {
    assert.equal(authority.persistence, 'src/kernel/state-store.ts');
    assert.ok(authority.semanticOwner.startsWith('src/kernel/'));
    assert.ok(authority.persistenceSources.length > 0);
    assert.ok(authority.tables.length > 0);
    assert.ok(authority.writeApis.length > 0);
  }
  assert.ok(contract.retiredOrForbiddenWriters.includes('bindStepAttemptReportDigest'));
});

test('W-03: canonical authority tables are mutated only by their same-connection owner stores', async () => {
  const contract = await readOwnership();
  const tableWriters = new Map(contract.authorities.flatMap((entry) => Object.entries(entry.tableWriters)));
  const tables = new Set(tableWriters.keys());
  const files = [
    ...await walk(path.join(ROOT, 'src', 'kernel')),
    ...await walk(path.join(ROOT, 'src', 'host', 'kernel')),
  ];
  const sqlMutation = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\s+([a-z0-9_]+)/ig;
  const leaks = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file).replaceAll('\\', '/');
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(sqlMutation)) {
      if (tables.has(match[1]) && !tableWriters.get(match[1])?.includes(relative)) leaks.push({ file: path.relative(ROOT, file), table: match[1] });
    }
  }
  assert.deepEqual(leaks, []);
});

test('W-03: obsolete persistence repositories are unreachable from production code', async () => {
  const contract = await readOwnership();
  const obsolete = new Set(contract.obsoletePersistenceModules || []);
  const files = [
    ...await walk(path.join(ROOT, 'src', 'kernel')),
    ...await walk(path.join(ROOT, 'src', 'host', 'kernel')),
  ];
  const findings = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file).replaceAll('\\', '/');
    if (obsolete.has(relative)) continue;
    const source = await readFile(file, 'utf8');
    for (const target of obsolete) {
      const base = path.basename(target);
      if (source.includes(base)) findings.push({ file: relative, target });
    }
  }
  assert.deepEqual(findings, []);
});

test('W-03: retired report-digest identity APIs have no production callers', async () => {
  const files = [
    ...await walk(path.join(ROOT, 'src', 'kernel')),
    ...await walk(path.join(ROOT, 'src', 'host', 'kernel')),
  ];
  const findings = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const symbol of ['findStepAttemptByReportDigest', 'bindStepAttemptReportDigest']) {
      if (source.includes(symbol)) findings.push({ file: path.relative(ROOT, file), symbol });
    }
  }
  assert.deepEqual(findings, []);
});
