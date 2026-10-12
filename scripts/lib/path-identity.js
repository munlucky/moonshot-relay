// Generated from src/shared/path-identity.ts. Edit the source and run npm run build.
import path from 'node:path';
export const canonicalPathIdentity = (value, { platform = process.platform } = {}) => {
    if (value === null || value === undefined)
        return '';
    const raw = String(value).trim();
    if (!raw)
        return '';
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const normalized = pathApi.normalize(raw.replaceAll('\\', '/')).replaceAll('\\', '/');
    const relative = normalized.replace(/^\.\/+/, '') || '.';
    return platform === 'win32' ? relative.toLowerCase() : relative;
};
