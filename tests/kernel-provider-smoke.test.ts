import { loadLegacyRecordFunction, loadLegacyStringArray } from './helpers/legacy-module-boundary.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const SURFACES = await loadLegacyStringArray('scripts/switcher/constants.mjs', 'SURFACES');
const nativeProviderDescriptor = await loadLegacyRecordFunction('scripts/switcher/native-provider.mjs', 'nativeProviderDescriptor');

function resolveCommandPath(command: unknown) {
  if (typeof command !== 'string' || !command) return null;
  if (path.isAbsolute(command)) return command;
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const executable = lines.find((line) => /\.(exe|cmd|bat)$/i.test(line)) || lines[0];
      if (executable) return executable;
    } catch {}
  } else {
    try {
      const output = execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 });
      const found = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (found) return found;
    } catch {}
  }
  return null;
}

test('Installed Provider Executable Smoke: evaluates native availability per surface', async (t) => {
  const results: Record<string, 'PASS' | 'FAIL' | 'SKIP_NOT_INSTALLED' | 'SKIP_BRIDGE_UNAVAILABLE'> = {};

  for (const surface of SURFACES) {
    await t.test(`Smoke Surface: ${surface}`, (st) => {
      let descriptor;
      try {
        descriptor = nativeProviderDescriptor({ surface });
      } catch {
        results[surface] = 'SKIP_NOT_INSTALLED';
        st.skip(`SKIP_NOT_INSTALLED: no descriptor for ${surface}`);
        return;
      }

      if (surface.endsWith('_cli')) {
        const binPath = resolveCommandPath(descriptor.command);
        if (!binPath) {
          results[surface] = 'SKIP_NOT_INSTALLED';
          st.skip(`SKIP_NOT_INSTALLED: ${descriptor.command} binary not found in PATH`);
          return;
        }

        // Test running CLI version check
        try {
          const versionOut = execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
          assert.ok(versionOut);
          results[surface] = 'PASS';
        } catch (err) {
          results[surface] = 'FAIL';
          assert.ok(err && typeof err === 'object' && 'message' in err);
          assert.fail(`CLI binary execution failed for ${surface}: ${err.message}`);
        }
      } else {
        // Desktop / App surfaces
        const binPath = resolveCommandPath(descriptor.command);
        if (!binPath) {
          results[surface] = 'SKIP_NOT_INSTALLED';
          st.skip(`SKIP_NOT_INSTALLED: ${descriptor.command} desktop binary not found`);
          return;
        }
        results[surface] = 'SKIP_BRIDGE_UNAVAILABLE';
        st.skip(`SKIP_BRIDGE_UNAVAILABLE: automated desktop UI interaction excluded from non-interactive smoke for ${surface}`);
      }
    });
  }

  // Print authentic smoke summary report
  console.log('\n--- Native Provider Smoke Summary ---');
  for (const [surface, status] of Object.entries(results)) {
    console.log(`  ${surface.padEnd(22)}: ${status}`);
  }
  console.log('-------------------------------------\n');
});
