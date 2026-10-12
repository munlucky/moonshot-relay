import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveProofRoute } from '../src/kernel/proof-route.js';
import { routeTask } from '../src/kernel/route.js';
import { buildEvidencePack } from '../src/kernel/evidence-pack.js';

const corpus: { cases: { id: string; taskClass: string; riskTier: "T0" | "T1" | "T2" | "T3"; expectedRoute: string[]; requiredEvidence: string[]; filesChanged?: number; surfaces?: string[]; objective: string }[] } = JSON.parse(await readFile(new URL('./fixtures/kernel-eval/corpus.json', import.meta.url), 'utf8'));
const evalProjects: Record<string, string> = {};
for (const track of ['kernel', 'relay']) {
  evalProjects[track] = await mkdtemp(path.join(os.tmpdir(), `krn-eval-${track}-`));
  await mkdir(path.join(evalProjects[track], '.moon-relay'), { recursive: true });
  await writeFile(path.join(evalProjects[track], '.moon-relay', 'track.yaml'), `schemaVersion: 1\ntrack: ${track}\nproduct: moon-relay-${track}\n`);
}

test('corpus contains thirty balanced representative cases', () => {
  assert.ok(corpus.cases.length >= 30);
  const counts: Record<string, number> = {};
  for (const c of corpus.cases) {
    counts[c.taskClass] = (counts[c.taskClass] || 0) + 1;
  }
  for (const c of ['analysis', 'bug', 'feature', 'refactor', 'ui', 'long-running']) {
    assert.equal(counts[c], 5);
  }
});

test('every case declares risk, route, source, and evidence and resolves proof route cleanly', () => {
  for (const c of corpus.cases) {
    assert.match(c.id, /^KRN-EVAL-\d{3}$/);
    assert.ok(['T0', 'T1', 'T2', 'T3'].includes(c.riskTier));
    assert.ok(c.expectedRoute.length >= 2);
    assert.ok(c.requiredEvidence.length);

    // Execute proof route resolution for each eval case
    const proofInput = {
      requestedTier: c.riskTier,
      filesChanged: c.filesChanged || 1,
      surfaces: c.surfaces || [],
    };
    const proofRoute = resolveProofRoute(proofInput);
    assert.ok(['T0', 'T1', 'T2', 'T3'].includes(proofRoute.proofTier));
    assert.ok(['E0', 'E1', 'E2'].includes(proofRoute.evidenceTier));
    assert.ok(Array.isArray(proofRoute.requiredChecks));
  }
});

test('eval corpus executes route and evidence assertions for every case', () => {
  for (const c of corpus.cases) {
    const activeTrack = c.id === 'KRN-EVAL-003' ? 'relay' : 'kernel';
    const routed = routeTask({ taskClass: c.taskClass, riskTier: c.riskTier, objective: c.objective, surfaces: c.surfaces || [] }, { projectRoot: evalProjects[activeTrack] });
    if (activeTrack === 'relay') {
      assert.equal(routed.status, 'wrong_harness');
      assert.ok(c.requiredEvidence.includes('wrong-harness-receipt'));
      continue;
    }
    assert.equal(routed.status, 'ready');
    assert.deepEqual(routed.route, c.expectedRoute);
    const evidence = buildEvidencePack({
      objective: c.objective,
      proofTier: c.riskTier,
      sliceCount: c.taskClass === 'long-running' ? 2 : 1,
      completionDecision: 'blocked',
      checks: [{ evidenceRef: `evidence://${c.id}`, status: 'passed' }],
    });
    const actualEvidence = new Set(['route-receipt', 'verification-result']);
    if (evidence.tier === 'E2') actualEvidence.add('release-evidence');
    for (const required of c.requiredEvidence) assert.ok(actualEvidence.has(required));
  }
});
