import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = path.resolve('.');
const script = path.join(root, 'scripts', 'capability-assets-check.mjs');

test('capability asset base validates manifests, provenance, catalog, subcapabilities, coverage ledger, and freeze boundary', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'pass');
  assert.equal(report.readOnly, true);
  assert.equal(report.catalogVersion, 4);
  assert.equal(report.baselineVersion, '2.1');
  assert.equal(report.assetCount, 15);
  assert.equal(report.subcapabilityCount, 47);
  assert.equal(report.checked.immutableCommits, 33);
  assert.equal(report.checked.proofPaths, 45);
  assert.equal(report.checked.subcapabilities, 47);
  assert.equal(report.checked.subcapabilitiesTraced, true);
  assert.equal(report.traceabilitySummary.traceabilityPct, 100);
  assert.equal(report.traceabilitySummary.withImplementationTrace, 47);
  assert.equal(report.traceabilitySummary.withProofTrace, 47);
  const ledger = JSON.parse(readFileSync(path.join(root, 'docs/capability-assets/coverage-ledger.yaml'), 'utf8'));
  assert.equal(report.checked.coverageSurfaces, Object.keys(ledger.surfaces).length);
  assert.equal(report.checked.rootBaselineForbidden, true);
  assert.equal(report.checked.canonicalBaselineExists, true);
  assert.equal(report.checked.decomplexificationMaps, true);
  assert.equal(report.checked.baselineTierConsistency, true);
  assert.equal(report.statusCounts.CORE, 9);
  assert.equal(report.statusCounts.HOST, 2);
  assert.equal(report.statusCounts.OPTIONAL, 2);
  assert.equal(report.statusCounts.REFERENCE, 1);
  assert.equal(report.statusCounts.DEPRECATED, 1);
  assert.equal(report.subcapabilityStatusCounts.CORE, 21);
  assert.equal(report.subcapabilityStatusCounts.HOST, 13);
  assert.equal(report.subcapabilityStatusCounts.OPTIONAL, 9);
  assert.equal(report.subcapabilityStatusCounts.REFERENCE, 2);
  assert.equal(report.subcapabilityStatusCounts.DEPRECATED, 2);
});
