// Generated from src/shared/runtime-assets.ts. Edit the source and run npm run build.
import { existsSync, readFileSync, realpathSync, } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PACKAGE_NAME = 'moonshot-relay';
const MAX_ANCESTORS = 12;
const modulePath = (moduleUrl) => (moduleUrl.startsWith('file:')
    ? fileURLToPath(moduleUrl)
    : path.resolve(moduleUrl));
const isRuntimeRoot = (candidate) => {
    const packageJsonPath = path.join(candidate, 'package.json');
    const kernelEntrypointPath = path.join(candidate, 'bin', 'moon-relay-kernel.mjs');
    if (!existsSync(packageJsonPath) || !existsSync(kernelEntrypointPath))
        return false;
    try {
        const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return manifest.name === PACKAGE_NAME;
    }
    catch {
        return false;
    }
};
export const resolveRuntimeRoot = (moduleUrl) => {
    let cursor = path.dirname(modulePath(moduleUrl));
    for (let depth = 0; depth <= MAX_ANCESTORS; depth += 1) {
        if (isRuntimeRoot(cursor))
            return cursor;
        const parent = path.dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    throw Object.assign(new Error(`runtime_root_not_found: ${moduleUrl}`), { code: 'runtime_root_not_found' });
};
export const resolveRuntimeAsset = (moduleUrl, ...segments) => path.join(resolveRuntimeRoot(moduleUrl), ...segments);
export const isDirectEntrypoint = (moduleUrl, argv = process.argv) => {
    if (!argv[1])
        return false;
    const expected = modulePath(moduleUrl);
    const invoked = path.resolve(argv[1]);
    try {
        return realpathSync(invoked) === realpathSync(expected);
    }
    catch {
        return invoked === expected;
    }
};
