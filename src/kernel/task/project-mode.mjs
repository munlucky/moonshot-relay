import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MANIFEST_FILES = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cc', '.cpp', '.cs', '.swift', '.kt']);
const WALK_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.moonshot-relay', '.moon-relay', '.tmp', '.history', 'vendor']);
const GREENFIELD_SOURCE_THRESHOLD = 3;

const hasGitHistory = (projectRoot) => {
  const result = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) return false;
  return Number(result.stdout.trim()) > 0;
};

const countSourceFiles = (projectRoot, cap = GREENFIELD_SOURCE_THRESHOLD + 1) => {
  let count = 0;
  const walk = (dir) => {
    if (count >= cap) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (count >= cap) return;
      if (WALK_EXCLUDES.has(name)) continue;
      const absolute = path.join(dir, name);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(absolute);
      else if (SOURCE_EXTENSIONS.has(path.extname(name))) count += 1;
    }
  };
  walk(projectRoot);
  return count;
};

// Greenfield vs Brownfield is an internal policy signal (never model-visible).
// A project with no build/test manifest, negligible source, no git history,
// and no prior Kernel knowledge is Greenfield; anything else is Brownfield.
export const detectProjectMode = ({ projectRoot = process.cwd(), hasKernelKnowledge = false } = {}) => {
  const manifests = MANIFEST_FILES.filter((file) => existsSync(path.join(projectRoot, file)));
  const sourceFileCount = countSourceFiles(projectRoot);
  const gitHistory = hasGitHistory(projectRoot);

  const brownfieldSignals = {
    hasManifest: manifests.length > 0,
    hasSource: sourceFileCount > GREENFIELD_SOURCE_THRESHOLD,
    hasGitHistory: gitHistory,
    hasKernelKnowledge: Boolean(hasKernelKnowledge),
  };
  const brownfield = Object.values(brownfieldSignals).some(Boolean);

  return {
    mode: brownfield ? 'brownfield' : 'greenfield',
    signals: brownfieldSignals,
    manifests,
    sourceFileCountAtLeast: sourceFileCount,
  };
};
