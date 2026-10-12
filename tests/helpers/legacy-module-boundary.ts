import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** Frozen compatibility modules are exercised outside the active Kernel source graph. */
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Legacy fixture returned no object');
  return value as Record<string, unknown>;
};
export async function loadLegacyFunction(modulePath: string, name: string) {
  const module: unknown = await import(pathToFileURL(path.resolve(modulePath)).href);
  const fn = record(module)[name];
  if (typeof fn !== 'function') throw new TypeError('Legacy fixture export is not callable: ' + name);
  return (...args: readonly unknown[]): unknown => Reflect.apply(fn, undefined, args);
}
export async function loadLegacyRecordFunction(modulePath: string, name: string) {
  const fn = await loadLegacyFunction(modulePath, name);
  return (...args: readonly unknown[]) => record(fn(...args));
}
export async function loadLegacyAsyncRecordFunction(modulePath: string, name: string) {
  const fn = await loadLegacyFunction(modulePath, name);
  return async (...args: readonly unknown[]) => record(await fn(...args));
}
export async function loadLegacyStringArray(modulePath: string, name: string): Promise<readonly string[]> {
  const module: unknown = await import(pathToFileURL(path.resolve(modulePath)).href);
  const values: unknown = record(module)[name];
  if (!Array.isArray(values) || !values.every((value: unknown): value is string => typeof value === 'string')) throw new TypeError('Legacy fixture export is not a string array');
  return values;
}

export async function loadLegacyRecord(modulePath: string, name: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(pathToFileURL(path.resolve(modulePath)).href);
  return record(record(module)[name]);
}

export async function loadLegacyStringSet(modulePath: string, name: string): Promise<ReadonlySet<string>> {
  const module: unknown = await import(pathToFileURL(path.resolve(modulePath)).href);
  const values: unknown = record(module)[name];
  if (!(values instanceof Set) || ![...values].every((value: unknown): value is string => typeof value === 'string')) throw new TypeError('Legacy fixture export is not a string set');
  return values;
}
