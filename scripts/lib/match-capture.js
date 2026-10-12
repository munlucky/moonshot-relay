// Generated from src/shared/match-capture.ts. Edit the source and run npm run build.
/** Return a required group from an already matched expression. Empty groups remain empty. */
export function matchCapture(match, index) {
    const value = match[index];
    if (value === undefined)
        throw new TypeError('Required regular expression capture is absent: ' + index);
    return value;
}
