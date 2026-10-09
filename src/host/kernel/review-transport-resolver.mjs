// Review Transport Resolver (Wave 5 / Wave 9).
// Resolves available trusted reviewer transports in priority order without
// invoking external shell or CLI subprocesses.

import { createClaudeAdapter } from './adapters/claude.mjs';
import { createCodexAdapter } from './adapters/codex.mjs';
import { createModelRegistry } from './model-registry.mjs';

// Resolver inputs are an internal Host boundary, not model-visible data. Keep
// a non-serializable attestation on every candidate so a capability-shaped
// object cannot enter the fallback chain merely by claiming the right flags.
// The dispatcher issues this token for caller-supplied Host transports; the
// resolver issues it only for its own built-in candidates. Config-only
// `overrides.reviewTransports` must already have been issued by a Host.
const REVIEW_TRANSPORT_ATTESTATION = Symbol('kernel.review-transport-attestation');

const candidateParts = (candidate) => {
  if (!candidate) return { adapter: null, entry: null };
  return candidate.adapter
    ? { adapter: candidate.adapter, entry: candidate }
    : { adapter: candidate, entry: { adapter: candidate } };
};

export const attestReviewTransport = (candidate, source = 'host') => {
  const { adapter, entry } = candidateParts(candidate);
  if (!adapter || typeof adapter !== 'object' || typeof adapter.dispatch !== 'function') return null;
  const attested = { ...entry };
  Object.defineProperty(attested, REVIEW_TRANSPORT_ATTESTATION, {
    value: Object.freeze({ source: String(source || 'host'), adapter }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return attested;
};

const hasHostAttestation = (candidate) => Boolean(
  candidate
  && candidate[REVIEW_TRANSPORT_ATTESTATION]?.adapter === candidateParts(candidate).adapter,
);

export const resolveReviewTransports = ({
  adapter = null,
  reviewFallbacks = [],
  hostAdapters = [],
  reviewTransports = [],
  env = process.env,
  runtimeHome = null,
  overrides = {},
} = {}) => {
  const explicitFallbacks = (Array.isArray(reviewFallbacks) ? reviewFallbacks : [])
    .filter(hasHostAttestation);
  const additionalAdapters = [
    ...(Array.isArray(hostAdapters) ? hostAdapters : []),
    ...(Array.isArray(reviewTransports) ? reviewTransports : []),
    ...(Array.isArray(overrides?.reviewTransports) ? overrides.reviewTransports : []),
  ].filter(hasHostAttestation);

  const candidates = [];

  // 1. Explicit fallbacks provided by caller
  for (const entry of explicitFallbacks) {
    if (entry) candidates.push(entry);
  }

  // 2. Additional configured trusted in-process host adapters
  for (const entry of additionalAdapters) {
    if (entry) candidates.push(entry);
  }

  // 3. Auto-discover alternate host reviewer transport based on primary adapter surface (optional cross-provider fallback)
  // Cross-provider transport is an optional fallback; when its launcher is unavailable, the dispatcher will skip it cleanly.
  const primarySurface = String(adapter?.surface || adapter?.capabilities?.surface || '').toLowerCase();
  if (primarySurface === 'codex') {
    candidates.push(attestReviewTransport({
      adapter: createClaudeAdapter({ launch: overrides?.claudeLauncher || overrides?.launchClaude || null, capabilities: overrides?.claudeCapabilities || {} }),
      registry: createModelRegistry({ surface: 'claude', runtimeHome, env, overrides }),
    }, 'resolver:auto'));
  } else if (primarySurface === 'claude') {
    candidates.push(attestReviewTransport({
      adapter: createCodexAdapter({ runtimeHome, env, nativeLaunch: overrides?.codexLauncher || overrides?.launchCodex || null, capabilities: overrides?.codexCapabilities || {} }),
      registry: createModelRegistry({ surface: 'codex', runtimeHome, env, overrides }),
    }, 'resolver:auto'));
  }

  // Deduplicate candidates and ensure no candidate matches the primary adapter
  const unique = candidates.filter((candidate, index, self) => {
    const candAdapter = candidate?.adapter || candidate;
    if (!candAdapter) return false;
    if (candAdapter === adapter) return false;
    return self.findIndex((other) => {
      const otherAdapter = other?.adapter || other;
      return candAdapter === otherAdapter;
    }) === index;
  });

  // Keep the review policy's provider preference independent of caller array
  // order: a trusted same-provider transport is the first fallback after the
  // current adapter, and cross-provider transports remain optional alternates.
  // Array.filter preserves the order within each group, so an operator can
  // still order multiple transports at the same priority.
  const sameProvider = unique.filter((candidate) => {
    const surface = String(candidate?.adapter?.capabilities?.surface || candidate?.adapter?.surface || '').toLowerCase();
    return surface && surface === primarySurface;
  });
  const alternateProvider = unique.filter((candidate) => {
    const surface = String(candidate?.adapter?.capabilities?.surface || candidate?.adapter?.surface || '').toLowerCase();
    return !surface || surface !== primarySurface;
  });
  return [...sameProvider, ...alternateProvider];
};
