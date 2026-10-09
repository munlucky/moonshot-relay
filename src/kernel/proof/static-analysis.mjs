#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SOURCE_ROOTS = ['bin', 'package', 'scripts', 'tests'];
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

const listJavaScript = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(target);
      }
    }
  };
  await visit(root);
  return files;
};

const projectRoot = process.cwd();
const files = (
  await Promise.all(SOURCE_ROOTS.map((relative) => listJavaScript(path.join(projectRoot, relative))))
).flat().sort();

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures.push({
      file: path.relative(projectRoot, file).replaceAll('\\', '/'),
      detail: String(result.stderr || result.stdout || `exit ${result.status}`).trim(),
    });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: 'failed', checked: files.length, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'passed', checked: files.length }));
