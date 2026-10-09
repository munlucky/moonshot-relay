import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MANIFEST_FILES = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const gitDirtyPaths = (projectRoot) => {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
};

// A narrow, objective-relevant repository scan (§16.2) — manifests, build/test
// commands, entrypoints, and the dirty working set. It never dumps the repo;
// it returns just enough for the model to locate the change seam.
export const scanRepositoryEvidence = ({ projectRoot = process.cwd() } = {}) => {
  const manifests = MANIFEST_FILES.filter((file) => existsSync(path.join(projectRoot, file)));
  const buildCommands = [];
  const testCommands = [];
  const entrypoints = [];

  const pkgPath = path.join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg) {
      const scripts = pkg.scripts || {};
      for (const [name] of Object.entries(scripts)) {
        if (/^(test|test:|check|typecheck|lint)/.test(name)) testCommands.push({ manifest: 'package.json', commandRef: name });
        if (/^(build|compile|bundle)/.test(name)) buildCommands.push({ manifest: 'package.json', commandRef: name });
      }
      if (pkg.main) entrypoints.push(pkg.main);
      if (pkg.bin) entrypoints.push(...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin)));
      if (pkg.exports) entrypoints.push('exports:package.json');
    }
  }

  return {
    entrypoints: [...new Set(entrypoints)],
    manifests,
    buildCommands,
    testCommands,
    dirtyPaths: gitDirtyPaths(projectRoot),
  };
};
