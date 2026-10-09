// Network policy (§11.5): inherited | blocked | required.
//
// Honesty rule: the Kernel must never record `networkIsolation: 'blocked'`
// unless isolation was *actually applied to the child process*. Declaring a
// mechanism is not enforcement, so this module resolves a concrete argv
// wrapper for a known mechanism and verifies the wrapper binary exists. When
// isolation is requested and no wrapper can be applied, the run is blocked
// rather than falsely marked isolated.

import { spawnSync } from 'node:child_process';

export const VALID_NETWORK_POLICIES = ['inherited', 'blocked', 'required'];

export class NetworkPolicyUnenforceableError extends Error {
  constructor(policy, message) {
    super(message);
    this.name = 'NetworkPolicyUnenforceableError';
    this.code = 'NETWORK_POLICY_UNENFORCEABLE';
    this.policy = policy;
  }
}

// Only mechanisms the Kernel knows how to actually invoke are trusted. An
// unknown string is a declaration, not an enforcement mechanism.
const WRAPPERS = Object.freeze({
  firejail: { binary: 'firejail', prefix: ['--quiet', '--net=none', '--'], platforms: ['linux'] },
  bwrap: { binary: 'bwrap', prefix: ['--unshare-net', '--dev-bind', '/', '/', '--'], platforms: ['linux'] },
  unshare: { binary: 'unshare', prefix: ['--net', '--map-root-user', '--'], platforms: ['linux'] },
});

export const SUPPORTED_NETWORK_MECHANISMS = Object.freeze(Object.keys(WRAPPERS));

const binaryExists = (binary) => {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [binary], { encoding: 'utf8' })
    : spawnSync('command', ['-v', binary], { encoding: 'utf8', shell: '/bin/sh' });
  return probe.status === 0 && Boolean((probe.stdout || '').trim());
};

// A mechanism is enforceable only when the host declares a *known* wrapper,
// the platform supports it, and the wrapper binary is really present.
export const probeNetworkEnforcement = ({ env = process.env, platform = process.platform, binaryExists: binaryProbe = binaryExists } = {}) => {
  const declared = String(env.MOON_RELAY_KERNEL_NETWORK_SANDBOX || '').trim();
  if (!declared) return { enforceable: false, mechanism: null, reason: 'no-mechanism-declared' };
  const wrapper = WRAPPERS[declared];
  if (!wrapper) {
    return { enforceable: false, mechanism: declared, reason: `unsupported-mechanism (supported: ${SUPPORTED_NETWORK_MECHANISMS.join(', ')})` };
  }
  if (!wrapper.platforms.includes(platform)) {
    return { enforceable: false, mechanism: declared, reason: `mechanism-not-supported-on-${platform}` };
  }
  if (!binaryProbe(wrapper.binary)) {
    return { enforceable: false, mechanism: declared, reason: `mechanism-binary-not-found:${wrapper.binary}` };
  }
  return { enforceable: true, mechanism: declared, wrapper, reason: null };
};

// Returns both the honest isolation fact AND the argv transform that produces
// it. Callers MUST apply `wrapArgv` — recording `blocked` without applying the
// wrapper is exactly the false boundary this module exists to prevent.
export const resolveNetworkExecution = ({ policy = 'inherited', env = process.env, platform = process.platform, binaryExists: binaryProbe = binaryExists } = {}) => {
  if (!VALID_NETWORK_POLICIES.includes(policy)) {
    throw new NetworkPolicyUnenforceableError(policy, `Unknown network policy: ${policy}`);
  }
  if (policy === 'inherited') {
    return { networkPolicy: 'inherited', networkIsolation: 'none', enforced: false, wrapArgv: (command, args) => ({ command, args }) };
  }

  const probe = probeNetworkEnforcement({ env, platform, binaryExists: binaryProbe });
  if (!probe.enforceable) {
    throw new NetworkPolicyUnenforceableError(
      policy,
      `network policy "${policy}" cannot be enforced in this environment (${probe.reason}); refusing to record a false isolation boundary`,
    );
  }
  const { wrapper } = probe;
  return {
    networkPolicy: policy,
    networkIsolation: 'blocked',
    enforced: true,
    mechanism: probe.mechanism,
    wrapArgv: (command, args) => ({ command: wrapper.binary, args: [...wrapper.prefix, command, ...args] }),
  };
};
