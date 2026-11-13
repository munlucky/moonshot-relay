#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateReadHook } from '../host/kernel/io-read-hook.js';
import { evaluateWriteHook } from '../host/kernel/io-write-hook.js';
import { isDirectEntrypoint } from '../shared/runtime-assets.js';

export async function main(runtimeHome = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), minLines = 350) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1024 * 1024) return;
  }
  try {
    const payload = JSON.parse(input);
    const result = payload?.hook_event_name === 'UserPromptSubmit'
      ? await evaluateWriteHook(payload, { runtimeHome })
      : await evaluateReadHook(payload, { runtimeHome, minLines });
    console.log(JSON.stringify(result));
  }
  catch { console.log('{}'); }
}
if (isDirectEntrypoint(import.meta.url)) await main();
