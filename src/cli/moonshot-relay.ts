#!/usr/bin/env node
import process from 'node:process';
import { runAccountInstall } from '../application/kernel-cli/account-install.js';
import { isDirectEntrypoint } from '../shared/runtime-assets.js';
export const main = runAccountInstall;
if (isDirectEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
