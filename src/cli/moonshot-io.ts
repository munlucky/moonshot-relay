#!/usr/bin/env node
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStandaloneIo, applyStandaloneIoCandidate } from '../host/kernel/io-standalone.js';
import { isDirectEntrypoint } from '../shared/runtime-assets.js';

export async function main(argv = process.argv.slice(2), cwd = process.cwd(), env = process.env) {
  const usage = 'usage: moonshot-io io-read|io-write|io-apply <request.json|-> [metadata.json] [--apply (io-write only)]';
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) { console.log(usage); return; }
  const apply = argv.includes('--apply');
  const [command, requestFile, outputFile, ...extra] = argv.filter(value => value !== '--apply');
  if (!['io-read', 'io-write', 'io-apply'].includes(command || '') || !requestFile || extra.length
    || (apply && command !== 'io-write') || argv.filter(value => value === '--apply').length > 1
    || [requestFile, outputFile].some(value => value?.startsWith('--'))) {
    throw Object.assign(new Error(usage), { code: 'standalone_io_usage' });
  }
  if (outputFile) {
    const destination = path.resolve(cwd, outputFile);
    try { await lstat(destination); throw Object.assign(new Error('metadata exists'), { code: 'EEXIST' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await realpath(path.dirname(destination));
  }
  let input;
  if (requestFile === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    input = Buffer.concat(chunks).toString('utf8');
  } else input = await readFile(path.resolve(cwd, requestFile), 'utf8');
  const request = JSON.parse(input);
  const io = createStandaloneIo({ projectRoot: cwd,
    runtimeHome: env.MOONSHOT_RELAY_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env });
  const generated = command === 'io-read' ? await io.read(request)
    : command === 'io-write' ? await io.write(request, apply) : await applyStandaloneIoCandidate(cwd, request);
  const { hostProductProof: _proof, ownerDelivery: _owner, kernelDone: _done, ...result } = generated as typeof generated
    & { hostProductProof?: unknown; ownerDelivery?: unknown; kernelDone?: unknown; metadataFailure?: string };
  if (outputFile) {
    try { await writeFile(path.resolve(cwd, outputFile), JSON.stringify(result, null, 2), { flag: 'wx' }); }
    catch (error) { result.metadataFailure = (error as NodeJS.ErrnoException).code || 'standalone_io_metadata_write_failed'; }
  }
  console.log(JSON.stringify(result));
  if (result.status !== 'answered' && result.status !== 'generated' && result.status !== 'created' || result.metadataFailure) process.exitCode = 1;
  return result;
}

if (isDirectEntrypoint(import.meta.url)) main().catch((error: unknown) => {
  const failure = error as NodeJS.ErrnoException & { destinationState?: string };
  console.log(JSON.stringify({ status: 'failed', failureCode: failure.code || 'standalone_io_failed',
    destinationState: failure.destinationState }));
  process.exitCode = 1;
});
