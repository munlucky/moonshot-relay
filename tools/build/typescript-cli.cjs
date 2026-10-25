#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const packageFile = require.resolve('typescript/package.json');
const metadata = require(packageFile);
const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.tsc;

if (!bin) {
  throw new Error('TypeScript package does not declare a tsc binary');
}

const compiler = path.resolve(path.dirname(packageFile), bin);
const result = spawnSync(
  process.execPath,
  [compiler, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
