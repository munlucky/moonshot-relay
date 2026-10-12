#!/usr/bin/env node
// Generated build tool. Edit the corresponding .ts source.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// npm also runs prepare in a development checkout. A runtime-only archive
// already contains the outputs and must not load the development compiler.
if (existsSync(path.join(root, 'src/kernel'))) {
    const { buildDevelopmentTools } = await import('./bootstrap.mjs');
    await buildDevelopmentTools();
    const { buildContractArtifacts } = await import('./contracts.mjs');
    await buildContractArtifacts({ root, check: true });
    const { buildRuntime } = await import('./runtime.mjs');
    await buildRuntime({ root });
    const { buildTests } = await import('./tests.mjs');
    await buildTests();
}
