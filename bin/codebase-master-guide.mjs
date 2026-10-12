#!/usr/bin/env node
// Generated from src/cli/codebase-master-guide.ts. Edit the source and run npm run build.
import { runStandaloneCli } from './moon-relay-standalone.mjs';
runStandaloneCli('codebase-master-guide', process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ status: 'error', errorCode: code || message }, null, 2)}\n`);
    process.exitCode = 1;
});
