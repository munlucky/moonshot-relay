/** Read an index whose presence is required by the caller's already selected work. */
export function requiredIndex<T>(values: readonly T[], index: number): T;
export function requiredIndex(values: string, index: number): string;
export function requiredIndex<T>(values: readonly T[] | string, index: number): T | string {
  const value = values[index];
  if (value === undefined) throw new RangeError('Required index is absent: ' + index);
  return value;
}
