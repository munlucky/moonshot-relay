import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transition, canTransition } from '../src/kernel/transition.js';

test('the persisted workflow exposes exactly the four-state transition matrix', () => {
  const allowed: Record<string, string[]> = {
    FRAME: ['EXECUTE', 'CLOSE'],
    EXECUTE: ['PROVE', 'FRAME'],
    PROVE: ['CLOSE', 'EXECUTE', 'FRAME'],
    CLOSE: [],
  };
  for (const [from, destinations] of Object.entries(allowed)) {
    for (const to of ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE']) {
      assert.equal(canTransition(from, to), destinations.includes(to), `${from} -> ${to}`);
    }
  }
});

test('valid transition advances and records history', () => {
  const n = transition({ state: 'FRAME', history: ['FRAME'] }, 'EXECUTE');
  assert.equal(n.state, 'EXECUTE');
  assert.deepEqual(n.history, ['FRAME', 'EXECUTE']);
});

test('invalid transition and CLOSE continuation are rejected', () => {
  assert.equal(canTransition('FRAME', 'PROVE'), false);
  assert.throws(() => transition({ state: 'FRAME', history: [] }, 'PROVE'));
  assert.equal(canTransition('CLOSE', 'FRAME'), false);
  assert.throws(() => transition({ state: 'CLOSE', history: ['FRAME', 'CLOSE'] }, 'FRAME'));
});
