#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateReadHook } from '../host/kernel/io-read-hook.js';
import { isDirectEntrypoint } from '../shared/runtime-assets.js';

export async function main(runtimeHome = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), minLines = 350) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1024 * 1024) return;
  }
  try { console.log(JSON.stringify(await evaluateReadHook(JSON.parse(input), { runtimeHome, minLines }))); }
  catch { console.log('{}'); }
}
if (isDirectEntrypoint(import.meta.url)) await main();
