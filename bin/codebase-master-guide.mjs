#!/usr/bin/env node
import { runStandaloneCli } from './moon-relay-standalone.mjs';

runStandaloneCli('codebase-master-guide', process.argv.slice(2))
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => { process.stdout.write(`${JSON.stringify({ status: 'error', errorCode: error.code || error.message }, null, 2)}\n`); process.exitCode = 1; });
