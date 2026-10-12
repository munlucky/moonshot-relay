// Generated from src/shared/canonical-digest.ts. Edit the source and run npm run build.
import { createHash } from 'node:crypto';
export const canonicalJson = (value) => {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value ?? null);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    const record = value;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
};
export const canonicalDigest = (value) => (`sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`);
export const digestWithout = (value, omitted = []) => {
    const rest = { ...(value || {}) };
    for (const key of omitted)
        delete rest[key];
    return canonicalDigest(rest);
};
