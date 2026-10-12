import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecordType, CANDIDATE_TO_RECORD_TYPE } from '../src/kernel/knowledge/records.js';

test('resolveRecordType preserves typed candidate types', () => {
  assert.equal(resolveRecordType('architecture_decision'), 'architecture_decision');
  assert.equal(resolveRecordType('domain_term'), 'domain_term');
  assert.equal(resolveRecordType('component_boundary'), 'component_boundary');
  assert.equal(resolveRecordType('api_contract'), 'api_contract');
  assert.equal(resolveRecordType('tacit_observation'), 'episodic_observation');
  assert.equal(resolveRecordType('tacit_practice'), 'episodic_observation');
  assert.equal(resolveRecordType('episodic_observation'), 'episodic_observation');
  assert.equal(resolveRecordType('known_failure_pattern'), 'known_failure_pattern');
  assert.equal(resolveRecordType('required_verification'), 'required_verification');
  assert.equal(resolveRecordType('semantic_fact'), 'semantic_fact');
});
