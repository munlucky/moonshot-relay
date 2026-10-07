import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve('.');
const ownershipPath = path.join(ROOT, 'docs', 'decomplexification', 'kernel-write-ownership.json');

const walk = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile() && full.endsWith('.mjs')) out.push(full);
  }
  return out;
};

test('W-03: authority ownership contract has exactly Work, Trust, and Knowledge semantic owners', async () => {
  const contract = JSON.parse(await readFile(ownershipPath, 'utf8'));
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.authorities.map((entry) => entry.id), ['work', 'trust', 'knowledge']);
  for (const authority of contract.authorities) {
    assert.equal(authority.persistence, 'scripts/kernel/state-store.mjs');
    assert.ok(authority.semanticOwner.startsWith('scripts/kernel/'));
    assert.ok(authority.tables.length > 0);
    assert.ok(authority.writeApis.length > 0);
  }
  assert.ok(contract.retiredOrForbiddenWriters.includes('bindStepAttemptReportDigest'));
});

test('W-03: canonical authority tables are mutated only by state-store SQL', async () => {
  const contract = JSON.parse(await readFile(ownershipPath, 'utf8'));
  const tables = new Set(contract.authorities.flatMap((entry) => entry.tables));
  const files = [
    ...await walk(path.join(ROOT, 'scripts', 'kernel')),
    ...await walk(path.join(ROOT, 'scripts', 'host', 'kernel')),
  ];
  const sqlMutation = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\s+([a-z0-9_]+)/ig;
  const leaks = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file).replaceAll('\\', '/');
    if (relative === 'scripts/kernel/state-store.mjs') continue;
    if ((contract.obsoletePersistenceModules || []).includes(relative)) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(sqlMutation)) {
      if (tables.has(match[1])) leaks.push({ file: path.relative(ROOT, file), table: match[1] });
    }
  }
  assert.deepEqual(leaks, []);
});

test('W-03: obsolete persistence repositories are unreachable from production code', async () => {
  const contract = JSON.parse(await readFile(ownershipPath, 'utf8'));
  const obsolete = new Set(contract.obsoletePersistenceModules || []);
  const files = [
    ...await walk(path.join(ROOT, 'scripts', 'kernel')),
    ...await walk(path.join(ROOT, 'scripts', 'host', 'kernel')),
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
    ...await walk(path.join(ROOT, 'scripts', 'kernel')),
    ...await walk(path.join(ROOT, 'scripts', 'host', 'kernel')),
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
