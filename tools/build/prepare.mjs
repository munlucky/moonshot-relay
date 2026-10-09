#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// npm also runs prepare in a development checkout. A runtime-only archive
// already contains the outputs and must not load the development compiler.
if (existsSync(path.join(root, 'src/kernel'))) {
  const { buildRuntime } = await import('./runtime.mjs');
  console.log(JSON.stringify(await buildRuntime({ root })));
}
