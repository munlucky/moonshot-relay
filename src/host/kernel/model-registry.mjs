// Host model registry (§10). This is the ONLY place a logical Kernel model
// class becomes a concrete provider model id, and it holds no provider SDK,
// endpoint, or credential — just the mapping the operator configured.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  EXECUTION_CLASSES,
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
  normalizeExecutionClass,
} from '../../kernel/run/execution-class.mjs';

export const CLASS_ENV_TOKEN = Object.freeze({ frontier_reasoning: 'FRONTIER', value_coding: 'VALUE' });
export const EXECUTION_ENV_TOKEN = Object.freeze({
  planning: 'PLANNING',
  complex_implementation: 'COMPLEX_IMPLEMENTATION',
  review: 'REVIEW',
  standard: 'STANDARD',
});
// 'model-policy' is applied by the turn dispatcher (Wave 5/6), not this
// registry, when MOON_RELAY_KERNEL_MODEL_POLICY_MODE=on overrides the class
// mapping below with the provider's own Sol/Terra/Luna or effort policy.
export const RESOLUTION_SOURCES = Object.freeze(['invocation-override', 'environment', 'profile-config', 'host-default', 'model-policy']);

const interpolate = (value, env) => String(value ?? '').replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => env[name] || '');

// hosts: <surface>: <modelClass>: { model, effort }
export const parseModelProfiles = (text, env = {}) => {
  const hosts = {};
  let surface = null;
  let modelClass = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^[A-Za-z]/.test(line)) { surface = null; modelClass = null; continue; }
    const surfaceMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (surfaceMatch) { surface = surfaceMatch[1]; hosts[surface] = hosts[surface] || {}; modelClass = null; continue; }
    const classMatch = line.match(/^ {4}([A-Za-z0-9_]+):\s*$/);
    if (classMatch && surface) { modelClass = classMatch[1]; hosts[surface][modelClass] = {}; continue; }
    const field = line.match(/^ {6}([A-Za-z0-9_]+):\s*(.+)$/);
    if (field && surface && modelClass) {
      const value = interpolate(field[2].trim().replace(/^['"]|['"]$/g, ''), env);
      if (value) hosts[surface][modelClass][field[1]] = value;
    }
  }
  return hosts;
};

export const loadModelProfiles = ({ runtimeHome, env = process.env, configPath } = {}) => {
  const file = configPath || (runtimeHome ? path.join(runtimeHome, 'config', 'model-profiles.yaml') : null);
  if (!file) return {};
  try {
    return parseModelProfiles(readFileSync(file, 'utf8'), env);
  } catch {
    return {};
  }
};

// §10.2 precedence: invocation override → host environment → profile config →
// installed Host default. Only the first three can ever be `enforced`, because
// only they mean the Kernel's requested class was explicitly applied.
export const resolveModelForExecutionClass = ({ surface, executionClass, overrides = {}, env = process.env, profiles = {} } = {}) => {
  const normalizedExecutionClass = normalizeExecutionClass(executionClass);
  const modelClass = legacyModelClassForExecutionClass(normalizedExecutionClass);
  if (normalizedExecutionClass === null) {
    return { executionClass: null, modelClass, surface, model: null, effort: null, source: 'kernel-runtime', enforcementIntent: 'not-applicable' };
  }
  const token = EXECUTION_ENV_TOKEN[normalizedExecutionClass];
  if (!token) throw new Error(`Unknown Kernel execution class: ${executionClass}`);
  const upperSurface = String(surface || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pick = (model, effort, source) => ({
    executionClass: normalizedExecutionClass,
    modelClass,
    surface,
    model: model || null,
    effort: effort || null,
    source,
    enforcementIntent: model ? (source === 'host-default' ? 'advisory' : 'enforced') : 'advisory',
  });

  const override = overrides[normalizedExecutionClass] ?? overrides[modelClass];
  if (override && (typeof override === 'string' ? override : override.model)) {
    const value = typeof override === 'string' ? { model: override } : override;
    return pick(value.model, value.effort, 'invocation-override');
  }
  const surfaceEnv = env[`MOON_RELAY_KERNEL_${upperSurface}_EXECUTION_${token}`]
    || env[`MOON_RELAY_KERNEL_${upperSurface}_${token}`]
    || env[`MOON_RELAY_KERNEL_${upperSurface}_${CLASS_ENV_TOKEN[modelClass] || token}`];
  const genericEnv = env[`MOON_RELAY_KERNEL_EXECUTION_${token}`]
    || env[`MOON_RELAY_KERNEL_MODEL_${CLASS_ENV_TOKEN[modelClass] || token}`];
  if (surfaceEnv || genericEnv) {
    const effort = env[`MOON_RELAY_KERNEL_${upperSurface}_EXECUTION_${token}_EFFORT`]
      || env[`MOON_RELAY_KERNEL_${upperSurface}_${token}_EFFORT`]
      || env[`MOON_RELAY_KERNEL_MODEL_${CLASS_ENV_TOKEN[modelClass] || token}_EFFORT`];
    return pick(surfaceEnv || genericEnv, effort, 'environment');
  }
  const configured = profiles?.[surface]?.[normalizedExecutionClass] || profiles?.[surface]?.[modelClass];
  if (configured?.model) return pick(configured.model, configured.effort, 'profile-config');
  // Nothing configured: the installed Host default runs, which is honest but
  // is NOT the Kernel enforcing a class, so it can only ever be advisory.
  return pick(null, null, 'host-default');
};

export const resolveModelForClass = ({ surface, modelClass, overrides = {}, env = process.env, profiles = {} } = {}) => {
  let executionClass;
  try {
    executionClass = executionClassFromLegacyModelClass(modelClass);
  } catch (error) {
    throw new Error(`Unknown Kernel model class: ${modelClass}`, { cause: error });
  }
  return resolveModelForExecutionClass({ surface, executionClass, overrides, env, profiles });
};

export const createModelRegistry = ({ surface, runtimeHome, env = process.env, configPath, overrides = {} } = {}) => {
  const profiles = loadModelProfiles({ runtimeHome, env, configPath });
  return {
    surface,
    profiles,
    resolveExecutionClass(executionClass, callOverrides = {}) {
      return resolveModelForExecutionClass({ surface, executionClass, overrides: { ...overrides, ...callOverrides }, env, profiles });
    },
    resolve(modelClass, callOverrides = {}) {
      return resolveModelForClass({ surface, modelClass, overrides: { ...overrides, ...callOverrides }, env, profiles });
    },
  };
};
