import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const createKernelFixture = async (prefix = 'krn-') => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `${prefix}home-`));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}proj-`));
  spawnSync('git', ['init', '-b', 'main'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Kernel Test'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'kernel-fixture',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'index.mjs'), 'export const active = true;\n');
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

export const cleanupKernelFixture = async ({ runtimeHome, projectRoot }: { runtimeHome?: string; projectRoot?: string } = {}) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (runtimeHome) await rm(runtimeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
};
