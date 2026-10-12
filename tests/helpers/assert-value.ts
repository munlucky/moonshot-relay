import assert from 'node:assert/strict';

export function assertTestRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function assertTestPresent<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined);
  return value;
}

export function assertTestString(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}

export function assertTestNumber(value: unknown): number {
  assert.ok(typeof value === 'number');
  return value;
}

export function assertTestArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

export function optionalTestRecord(value: unknown): Record<string, unknown> | undefined {
  return value == null ? undefined : assertTestRecord(value);
}

export function parseCliErrorReceipt(output: string): Record<string, unknown> {
  // Node may append an experimental SDK warning to stderr after the receipt.
  const receipts = output.split(/\r?\n/).filter(line => line.trimStart().startsWith('{'));
  assert.equal(receipts.length, 1, 'Expected one structured CLI error receipt');
  return assertTestRecord(JSON.parse(assertTestString(receipts[0])));
}
