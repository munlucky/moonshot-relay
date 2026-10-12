import { randomUUID } from 'node:crypto';

export const createOpaqueRunId = (): string => `run-${randomUUID()}`;
