#!/usr/bin/env node
// Generated from src/cli/moonshot-relay.ts. Edit the source and run npm run build.
import process from 'node:process';
import { runAccountInstall } from '../scripts/application/kernel-cli/account-install.js';
import { isDirectEntrypoint } from '../scripts/lib/runtime-assets.js';
export const main = runAccountInstall;
if (isDirectEntrypoint(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
