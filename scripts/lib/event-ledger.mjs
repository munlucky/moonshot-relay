import { appendFile, readFile } from 'node:fs/promises';

import { sha256Hex } from './candidate-identity.js';

const GENESIS_HASH = '0'.repeat(64);

export const ledgerEventHash = (event) => sha256Hex({
  schemaVersion: event.schemaVersion,
  sequence: event.sequence,
  previousHash: event.previousHash,
  type: event.type,
  payload: event.payload,
  createdAt: event.createdAt,
});

export const createLedgerEvent = ({
  sequence,
  previousHash = GENESIS_HASH,
  type,
  payload = {},
  createdAt = new Date().toISOString(),
} = {}) => {
  if (!type) throw new Error('ledger event type is required');
  const event = {
    schemaVersion: 1,
    sequence,
    previousHash,
    type,
    payload,
    createdAt,
  };
  return {
    ...event,
    eventHash: ledgerEventHash(event),
  };
};

export const appendLedgerEvent = async (ledgerPath, eventInput) => {
  const events = await readLedger(ledgerPath).catch(() => []);
  const previous = events.at(-1);
  const event = createLedgerEvent({
    sequence: events.length + 1,
    previousHash: previous?.eventHash || GENESIS_HASH,
    ...eventInput,
  });
  await appendFile(ledgerPath, `${JSON.stringify(event)}\n`);
  return event;
};

export const readLedger = async (ledgerPath) => {
  const content = await readFile(ledgerPath, 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

export const verifyLedger = (events = []) => {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1) {
      return { valid: false, reason: `invalid sequence at ${index + 1}` };
    }
    if (event.previousHash !== previousHash) {
      return { valid: false, reason: `previous hash mismatch at ${event.sequence}` };
    }
    const expected = ledgerEventHash(event);
    if (event.eventHash !== expected) {
      return { valid: false, reason: `event hash mismatch at ${event.sequence}` };
    }
    previousHash = event.eventHash;
  }
  return { valid: true, reason: '' };
};

export const reconstructResumeState = (events = []) => {
  const verified = verifyLedger(events);
  if (!verified.valid) throw new Error(`invalid event ledger: ${verified.reason}`);
  const completedPhases = events
    .filter((event) => event.type === 'phase.completed')
    .map((event) => event.payload?.phase)
    .filter(Boolean);
  const blockers = events
    .filter((event) => event.type === 'phase.blocked')
    .map((event) => event.payload);
  const last = events.at(-1) || null;
  return {
    status: blockers.length > 0 ? 'blocked' : 'ready',
    completedPhases,
    currentBlocker: blockers.at(-1) || null,
    nextTransition: last?.type === 'phase.completed' ? 'start_next_phase' : 'resume_current_phase',
    authority: 'runtime_events_authoritative_jsonl_replay_mirror',
  };
};
