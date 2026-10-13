#!/usr/bin/env node
import { runStandaloneCli } from './moon-relay-standalone.js';

runStandaloneCli('kernel-commit', process.argv.slice(2))
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    const recovery = error && typeof error === 'object' && 'recovery' in error ? error.recovery : undefined;
    process.stdout.write(`${JSON.stringify({ status: 'error', errorCode: code || message, recovery }, null, 2)}\n`);
    process.exitCode = 1;
  });
