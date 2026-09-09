import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import {
  normalizeHostCapabilities,
  resolveEnforcementStrategy,
} from '../scripts/kernel/run/model-route-contract.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-surface-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-surface-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'cross-surface-matrix-test',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'main.mjs'), 'export const ready = true;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const SURFACE_PROFILES = [
  {
    surface: 'codex-cli',
    capabilities: {
      surface: 'codex-cli',
      supportsSessionModelOverride: true,
      supportsResolvedModelIdentity: true,
      supportsIndependentContext: true,
    },
    expectedStrategy: 'session',
  },
  {
    surface: 'codex-desktop',
    capabilities: {
      surface: 'codex-desktop',
      supportsSubagentModel: true,
      supportsResolvedModelIdentity: true,
      supportsIndependentContext: true,
    },
    expectedStrategy: 'subagent',
  },
  {
    surface: 'claude-code',
    capabilities: {
      surface: 'claude-code',
      supportsSubagentModel: true,
      supportsResolvedModelIdentity: true,
      supportsIndependentContext: true,
    },
    expectedStrategy: 'subagent',
  },
  {
    surface: 'claude-desktop',
    capabilities: {
      surface: 'claude-desktop',
      supportsSessionModelOverride: false,
      supportsResolvedModelIdentity: false,
    },
    expectedStrategy: 'unsupported',
  },
  {
    surface: 'antigravity',
    capabilities: {
      surface: 'antigravity',
      supportsSubagentModel: true,
      supportsSessionModelOverride: true,
      supportsResolvedModelIdentity: true,
      supportsIndependentContext: true,
      supportsCrossSurfaceReview: true,
    },
    expectedStrategy: 'subagent',
  },
  {
    surface: 'qwen-code',
    capabilities: {
      surface: 'qwen-code',
      supportsSessionModelOverride: true,
      supportsResolvedModelIdentity: false,
    },
    expectedStrategy: 'advisory',
  },
  {
    surface: 'ade',
    capabilities: {
      surface: 'ade',
      supportsSubagentModel: true,
      supportsIndependentContext: true,
      supportsResolvedModelIdentity: false,
    },
    expectedStrategy: 'advisory',
  },
];

test('Cross-Surface Matrix: All 7 surfaces normalize capabilities and resolve expected enforcement strategies', async () => {
  for (const profile of SURFACE_PROFILES) {
    const normalized = normalizeHostCapabilities(profile.capabilities);
    assert.equal(normalized.surface, profile.surface, `Surface name must match: ${profile.surface}`);
    const strategy = resolveEnforcementStrategy(profile.capabilities);
    assert.equal(
      strategy,
      profile.expectedStrategy,
      `Surface ${profile.surface} must resolve strategy ${profile.expectedStrategy}, got ${strategy}`,
    );
  }
});

test('Cross-Surface Matrix: Control plane dispatches hostNext cleanly across all 7 surface profiles', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-surface-matrix-1';
    await cp.startRun({
      runId,
      objective: 'verify host turn dispatch across 7 surface profiles',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit test works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['main.mjs'],
      },
    });

    for (const profile of SURFACE_PROFILES) {
      const hostTurn = await cp.hostNext(runId, {
        hostCapabilities: profile.capabilities,
      });
      assert.ok(hostTurn.hostDirective, `hostNext must produce hostDirective for surface ${profile.surface}`);
      assert.ok(hostTurn.modelInput, `hostNext must produce modelInput for surface ${profile.surface}`);
      assert.equal(hostTurn.modelInput.action?.type, 'implement');
    }
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
