import { randomUUID } from 'node:crypto';

export function createOpaqueRunId() {
  return `run-${randomUUID()}`;
}
