// Generated from src/shared/required-index.ts. Edit the source and run npm run build.
export function requiredIndex(values, index) {
    const value = values[index];
    if (value === undefined)
        throw new RangeError('Required index is absent: ' + index);
    return value;
}
