#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStandaloneIo, applyStandaloneIoCandidate } from '../host/kernel/io-standalone.js';
import { isDirectEntrypoint } from '../shared/runtime-assets.js';

export async function main(argv = process.argv.slice(2), cwd = process.cwd(), env = process.env) {
  const [command, requestFile, outputFile] = argv;
  if (!['io-read', 'io-write', 'io-apply'].includes(command || '') || !requestFile || argv.length > 3) {
    throw Object.assign(new Error('usage: moonshot-io io-read|io-write|io-apply request.json [metadata.json]'), { code: 'standalone_io_usage' });
  }
  const request = JSON.parse(await readFile(path.resolve(cwd, requestFile), 'utf8'));
  const io = createStandaloneIo({ projectRoot: cwd,
    runtimeHome: env.MOONSHOT_RELAY_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env });
  const result = command === 'io-read' ? await io.read(request)
    : command === 'io-write' ? await io.write(request) : await applyStandaloneIoCandidate(cwd, request);
  if (outputFile) await writeFile(path.resolve(cwd, outputFile), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
  if (result.status === 'failed') process.exitCode = 1;
  return result;
}

if (isDirectEntrypoint(import.meta.url)) main().catch((error: unknown) => {
  const failure = error as NodeJS.ErrnoException & { destinationState?: string };
  console.log(JSON.stringify({ status: 'failed', failureCode: failure.code || 'standalone_io_failed',
    destinationState: failure.destinationState }));
  process.exitCode = 1;
});
