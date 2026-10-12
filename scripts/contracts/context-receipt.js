// Generated from src/contracts/context-receipt.ts. Edit the source and run npm run build.
import { parseKernelContract } from './schema-codec.js';
import { createHash } from 'node:crypto';
export const canonicalStringify = (value) => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalStringify(item))).join(',')}]`;
    }
    const record = value;
    const pairs = [];
    for (const key of Object.keys(record).sort()) {
        const nested = record[key];
        if (nested !== undefined) {
            pairs.push(`${JSON.stringify(key)}:${canonicalStringify(nested)}`);
        }
    }
    return `{${pairs.join(',')}}`;
};
export const digestObject = (value) => (createHash('sha256').update(canonicalStringify(value)).digest('hex'));
export const makeContextReceipt = ({ stage, policyRevision, policyDigest, included, omitted, tokenEstimate, }) => {
    const payload = {
        schemaVersion: 1,
        stage,
        policyRevision,
        policyDigest,
        tokenEstimate,
        included,
        omitted,
    };
    const digest = digestObject(payload);
    const receipt = parseKernelContract('kernel.context-receipt', {
        ...payload,
        receiptId: `ctx-${digest.slice(0, 12)}`,
        digest,
    });
    return { ...receipt, policyDigest };
};
