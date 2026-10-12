#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import {
  auditSkillsLock,
  buildSkillsLock,
} from './kernel/standalone/skills-lock.js';

const usage = () => 'Usage: node scripts/skills-audit.mjs audit [--lock <skills-lock.json>] [--runtime-surface <runtime-surface.json>] [--json]\n       node scripts/skills-audit.mjs generate-lock [--out <skills-lock.json>] [--default-license <license>] [--default-permissions-json <json-array>] [--approve-permissions] [--json]';

const parseArgs = (argv) => {
  const options = { command: argv[0] || '', json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lock') options.lock = argv[++index] || '';
    else if (arg === '--runtime-surface') options.runtimeSurface = argv[++index] || '';
    else if (arg === '--out') options.out = argv[++index] || '';
    else if (arg === '--default-license') options.defaultLicense = argv[++index] || '';
    else if (arg === '--default-permissions-json') options.defaultPermissionsJson = argv[++index] || '';
    else if (arg === '--approve-permissions') options.approvePermissions = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.command === 'generate-lock') {
    const defaultPermissions = args.defaultPermissionsJson
      ? JSON.parse(args.defaultPermissionsJson)
      : ['filesystem-read'];
    const lock = await buildSkillsLock({
      defaultLicense: args.defaultLicense || 'UNSPECIFIED',
      defaultPermissions,
    });
    if (args.approvePermissions) {
      for (const skill of lock.skills) {
        skill.permissionReview = {
          status: 'approved',
          reviewedAt: lock.generatedAt,
          reviewer: 'skills-audit-generate-lock',
        };
      }
    }
    if (args.out) await writeFile(args.out, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    if (args.json) console.log(JSON.stringify({ status: 'generated', lock, wrote: args.out || '' }, null, 2));
    else console.log('generated');
    return;
  }
  if (args.command !== 'audit') throw new Error(`Unknown command: ${args.command}\n${usage()}`);
  const lock = args.lock ? await readJson(args.lock) : null;
  const runtimeSurface = args.runtimeSurface ? await readJson(args.runtimeSurface) : null;
  const result = await auditSkillsLock({ lock, runtimeSurface });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.status);
  if (result.status === 'blocked') process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
