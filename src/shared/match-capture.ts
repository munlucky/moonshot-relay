/** Return a required group from an already matched expression. Empty groups remain empty. */
export function matchCapture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new TypeError('Required regular expression capture is absent: ' + index);
  return value;
}
