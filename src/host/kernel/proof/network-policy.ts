// Network policy (§11.5): inherited | blocked | required.
//
// Honesty rule: the Kernel must never record `networkIsolation: 'blocked'`
// unless isolation was *actually applied to the child process*. Declaring a
// mechanism is not enforcement, so this module resolves a concrete argv
// wrapper for a known mechanism and verifies the wrapper binary exists. When
// isolation is requested and no wrapper can be applied, the run is blocked
// rather than falsely marked isolated.

import { spawnSync } from 'node:child_process';

export const VALID_NETWORK_POLICIES = ['inherited', 'blocked', 'required'] as const;
export type NetworkPolicy = (typeof VALID_NETWORK_POLICIES)[number];

interface NetworkWrapper {
  binary: string;
  prefix: string[];
  platforms: string[];
}

interface NetworkProbe {
  enforceable: boolean;
  mechanism: string | null;
  reason: string | null;
  wrapper?: NetworkWrapper;
}

type BinaryProbe = (binary: string) => boolean;

export class NetworkPolicyUnenforceableError extends Error {
  readonly code = 'NETWORK_POLICY_UNENFORCEABLE';
  readonly policy: unknown;

  constructor(policy: unknown, message: string) {
    super(message);
    this.name = 'NetworkPolicyUnenforceableError';
    this.policy = policy;
  }
}

// Only mechanisms the Kernel knows how to actually invoke are trusted. An
// unknown string is a declaration, not an enforcement mechanism.
const WRAPPERS: Readonly<Record<string, NetworkWrapper>> = Object.freeze({
  firejail: {
    binary: 'firejail',
    prefix: ['--quiet', '--net=none', '--'],
    platforms: ['linux'],
  },
  bwrap: {
    binary: 'bwrap',
    prefix: ['--unshare-net', '--dev-bind', '/', '/', '--'],
    platforms: ['linux'],
  },
  unshare: {
    binary: 'unshare',
    prefix: ['--net', '--map-root-user', '--'],
    platforms: ['linux'],
  },
});

export const SUPPORTED_NETWORK_MECHANISMS = Object.freeze(Object.keys(WRAPPERS));

const binaryExists = (binary: string): boolean => {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [binary], { encoding: 'utf8' })
    : spawnSync('command', ['-v', binary], {
      encoding: 'utf8',
      shell: '/bin/sh',
    });
  return probe.status === 0 && Boolean((probe.stdout || '').trim());
};

// A mechanism is enforceable only when the host declares a *known* wrapper,
// the platform supports it, and the wrapper binary is really present.
export const probeNetworkEnforcement = ({
  env = process.env,
  platform = process.platform,
  binaryExists: binaryProbe = binaryExists,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  binaryExists?: BinaryProbe;
} = {}): NetworkProbe => {
  const declared = String(env.MOON_RELAY_KERNEL_NETWORK_SANDBOX || '').trim();
  if (!declared) {
    return {
      enforceable: false,
      mechanism: null,
      reason: 'no-mechanism-declared',
    };
  }
  const wrapper = WRAPPERS[declared];
  if (!wrapper) {
    return {
      enforceable: false,
      mechanism: declared,
      reason: `unsupported-mechanism (supported: ${SUPPORTED_NETWORK_MECHANISMS.join(', ')})`,
    };
  }
  if (!wrapper.platforms.includes(platform)) {
    return {
      enforceable: false,
      mechanism: declared,
      reason: `mechanism-not-supported-on-${platform}`,
    };
  }
  if (!binaryProbe(wrapper.binary)) {
    return {
      enforceable: false,
      mechanism: declared,
      reason: `mechanism-binary-not-found:${wrapper.binary}`,
    };
  }
  return {
    enforceable: true,
    mechanism: declared,
    wrapper,
    reason: null,
  };
};

// Returns both the honest isolation fact AND the argv transform that produces
// it. Callers MUST apply `wrapArgv` — recording `blocked` without applying the
// wrapper is exactly the false boundary this module exists to prevent.
export const resolveNetworkExecution = ({
  policy = 'inherited',
  env = process.env,
  platform = process.platform,
  binaryExists: binaryProbe = binaryExists,
}: {
  policy?: unknown;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  binaryExists?: BinaryProbe;
} = {}) => {
  if (!VALID_NETWORK_POLICIES.includes(policy as NetworkPolicy)) {
    throw new NetworkPolicyUnenforceableError(
      policy,
      `Unknown network policy: ${String(policy)}`,
    );
  }
  const normalizedPolicy = policy as NetworkPolicy;
  if (normalizedPolicy === 'inherited') {
    return {
      networkPolicy: 'inherited' as const,
      networkIsolation: 'none' as const,
      enforced: false,
      wrapArgv: (command: string, args: readonly string[] = []) => ({
        command,
        args: [...args],
      }),
    };
  }

  const probe = probeNetworkEnforcement({
    env,
    platform,
    binaryExists: binaryProbe,
  });
  if (!probe.enforceable || !probe.wrapper) {
    throw new NetworkPolicyUnenforceableError(
      normalizedPolicy,
      `network policy "${normalizedPolicy}" cannot be enforced in this environment (${probe.reason}); refusing to record a false isolation boundary`,
    );
  }
  const wrapper = probe.wrapper;
  return {
    networkPolicy: normalizedPolicy,
    networkIsolation: 'blocked' as const,
    enforced: true,
    mechanism: probe.mechanism,
    wrapArgv: (command: string, args: readonly string[] = []) => ({
      command: wrapper.binary,
      args: [...wrapper.prefix, command, ...args],
    }),
  };
};
