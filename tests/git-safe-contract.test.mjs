import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

import {
  gitConfigValue,
  gitCurrentBranch,
  gitLsFiles,
  gitSafeArgs,
  gitStatusBranchLine,
  runGit,
} from '../scripts/lib/git-safe.js';

const root = process.cwd();

test('gitSafeArgs injects safe.directory before command args', () => {
  assert.deepEqual(
    gitSafeArgs(root, ['ls-files', '--', 'docs']),
    ['-c', `safe.directory=${path.resolve(root)}`, 'ls-files', '--', 'docs'],
  );
});

test('runGit executes from repo root with utf8 output', () => {
  const result = runGit(root, ['rev-parse', '--show-toplevel']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(path.resolve(result.stdout.trim()), path.resolve(root));
});

test('gitLsFiles separates pathspecs with --', () => {
  const result = gitLsFiles(root, ['docs']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('docs/public/'), 'expected tracked public docs in ls-files output');
});

test('status, config, and branch helpers return safe strings', () => {
  assert.match(gitStatusBranchLine(root), /^## /);
  assert.equal(typeof gitConfigValue(root, 'remote.origin.url'), 'string');
  assert.equal(typeof gitCurrentBranch(root), 'string');
});
