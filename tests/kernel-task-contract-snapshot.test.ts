import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTaskContract, readTaskContractSnapshot } from '../src/kernel/task/task-contract.js';

test('canonical persisted contract preserves its original digest and seed provenance', () => {
  const contract = normalizeTaskContract({
    objective: 'Preserve the persisted contract',
    acceptance: [{ id: 'AC-1', statement: 'Keep authoritative receipts', evidencePlan: { class: 'hard', commandRefs: ['typecheck'] } }],
    allowedPaths: ['src/**'],
  });
  const persisted = JSON.parse(JSON.stringify(contract));
  persisted.seedProvenance = { seedId: 'seed-original', consumedPaths: ['agreement.md'] };
  assert.deepEqual(readTaskContractSnapshot(persisted), persisted);
  assert.equal(readTaskContractSnapshot(persisted).digest, contract.digest);
});

test('malformed canonical snapshots fail closed before Control Plane composition', () => {
  const valid = normalizeTaskContract({ objective: 'Reject corrupted state', acceptance: ['Keep the contract'] });
  for (const mutate of [
    (value: { allowedPaths: unknown; acceptance: { evidencePlan: unknown }[]; completionPredicate: { requiredOutcomes: unknown }; filesChanged: unknown }) => { value.allowedPaths = 'src/**'; },
    (value: { allowedPaths: unknown; acceptance: { evidencePlan: unknown }[]; completionPredicate: { requiredOutcomes: unknown }; filesChanged: unknown }) => { value.acceptance[0].evidencePlan = { class: 'hard', commandRefs: 'typecheck' }; },
    (value: { allowedPaths: unknown; acceptance: { evidencePlan: unknown }[]; completionPredicate: { requiredOutcomes: unknown }; filesChanged: unknown }) => { value.completionPredicate.requiredOutcomes = [42]; },
    (value: { allowedPaths: unknown; acceptance: { evidencePlan: unknown }[]; completionPredicate: { requiredOutcomes: unknown }; filesChanged: unknown }) => { value.filesChanged = 'one'; },
  ]) {
    const snapshot = JSON.parse(JSON.stringify(valid));
    mutate(snapshot);
    assert.throws(() => readTaskContractSnapshot(snapshot), /invalid persisted Task Contract/);
  }
});

test('legacy snapshots use the existing normalizer at the read boundary', () => {
  const legacy = { acceptance: ['Keep legacy acceptance'], allowedPaths: ['src/**'] };
  assert.deepEqual(readTaskContractSnapshot(legacy, 'Legacy task'), normalizeTaskContract(legacy, { objective: 'Legacy task' }));
});
