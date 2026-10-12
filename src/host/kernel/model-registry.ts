import { matchCapture } from '../../shared/match-capture.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { ExecutionClass, LegacyModelClass } from '../../contracts/execution-class.js';
import {
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
  normalizeExecutionClass,
} from '../../contracts/execution-class.js';

export const CLASS_ENV_TOKEN: Readonly<Partial<Record<LegacyModelClass, string>>> = Object.freeze({
  frontier_reasoning: 'FRONTIER',
  value_coding: 'VALUE',
});

export const EXECUTION_ENV_TOKEN: Readonly<Record<ExecutionClass, string>> = Object.freeze({
  planning: 'PLANNING',
  complex_implementation: 'COMPLEX_IMPLEMENTATION',
  review: 'REVIEW',
  standard: 'STANDARD',
});

export const RESOLUTION_SOURCES = [
  'invocation-override',
  'environment',
  'profile-config',
  'host-default',
  'model-policy',
] as const;

export type ModelResolutionSource =
  | typeof RESOLUTION_SOURCES[number]
  | 'kernel-runtime';

export interface ModelSetting {
  model?: string | null;
  effort?: string | null;
  [key: string]: string | null | undefined;
}

export type ModelOverride = string | ModelSetting;
export type ModelOverrideMap = Partial<Record<ExecutionClass | LegacyModelClass, ModelOverride>>;
export type ModelProfiles = Record<string, Record<string, ModelSetting>>;

export interface ModelResolution {
  executionClass: ExecutionClass | null;
  modelClass: LegacyModelClass;
  surface: string | null;
  model: string | null;
  effort: string | null;
  source: ModelResolutionSource;
  enforcementIntent: 'enforced' | 'advisory' | 'not-applicable';
}

interface ModelRegistryOptions {
  surface?: string | null;
  runtimeHome?: (string | null) | undefined;
  env?: NodeJS.ProcessEnv;
  configPath?: string | null;
  overrides?: ModelOverrideMap;
}

interface ResolveExecutionClassInput {
  surface?: string | null;
  executionClass?: unknown;
  overrides?: ModelOverrideMap;
  env?: NodeJS.ProcessEnv;
  profiles?: ModelProfiles;
}

interface ResolveLegacyClassInput {
  surface?: string | null;
  modelClass?: unknown;
  overrides?: ModelOverrideMap;
  env?: NodeJS.ProcessEnv;
  profiles?: ModelProfiles;
}

const interpolate = (value: unknown, env: NodeJS.ProcessEnv) => (
  String(value ?? '').replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] || '')
);

export const parseModelProfiles = (
  text: unknown,
  env: NodeJS.ProcessEnv = {},
): ModelProfiles => {
  const hosts: ModelProfiles = {};
  let surface: string | null = null;
  let modelClass: string | null = null;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^[A-Za-z]/.test(line)) {
      surface = null;
      modelClass = null;
      continue;
    }

    const surfaceMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (surfaceMatch) {
      surface = matchCapture(surfaceMatch, 1);
      hosts[surface] = hosts[surface] || {};
      modelClass = null;
      continue;
    }

    const classMatch = line.match(/^ {4}([A-Za-z0-9_]+):\s*$/);
    if (classMatch && surface) {
      modelClass = matchCapture(classMatch, 1);
      (hosts[surface] ??= {})[modelClass] = {};
      continue;
    }

    const field = line.match(/^ {6}([A-Za-z0-9_]+):\s*(.+)$/);
    if (field && surface && modelClass) {
      const value = interpolate(matchCapture(field, 2).trim().replace(/^['"]|['"]$/g, ''), env);
      if (value) ((hosts[surface] ??= {})[modelClass] ??= {})[matchCapture(field, 1)] = value;
    }
  }
  return hosts;
};

export const loadModelProfiles = ({
  runtimeHome,
  env = process.env,
  configPath,
}: Omit<ModelRegistryOptions, 'surface' | 'overrides'> = {}): ModelProfiles => {
  const file = configPath || (runtimeHome ? path.join(runtimeHome, 'config', 'model-profiles.yaml') : null);
  if (!file) return {};
  try {
    return parseModelProfiles(readFileSync(file, 'utf8'), env);
  } catch {
    return {};
  }
};

const overrideFor = (
  overrides: ModelOverrideMap,
  executionClass: ExecutionClass,
  modelClass: LegacyModelClass,
): ModelOverride | undefined => overrides[executionClass] ?? overrides[modelClass];

const normalizeOverride = (override: ModelOverride): ModelSetting => (
  typeof override === 'string' ? { model: override } : override
);

export const resolveModelForExecutionClass = ({
  surface = null,
  executionClass,
  overrides = {},
  env = process.env,
  profiles = {},
}: ResolveExecutionClassInput = {}): ModelResolution => {
  const normalizedExecutionClass = normalizeExecutionClass(executionClass);
  const modelClass = legacyModelClassForExecutionClass(normalizedExecutionClass);

  if (normalizedExecutionClass === null) {
    return {
      executionClass: null,
      modelClass,
      surface,
      model: null,
      effort: null,
      source: 'kernel-runtime',
      enforcementIntent: 'not-applicable',
    };
  }

  const token = EXECUTION_ENV_TOKEN[normalizedExecutionClass];
  const upperSurface = String(surface || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const pick = (
    model: string | null | undefined,
    effort: string | null | undefined,
    source: ModelResolutionSource,
  ): ModelResolution => ({
    executionClass: normalizedExecutionClass,
    modelClass,
    surface,
    model: model || null,
    effort: effort || null,
    source,
    enforcementIntent: model
      ? (source === 'host-default' ? 'advisory' : 'enforced')
      : 'advisory',
  });

  const override = overrideFor(overrides, normalizedExecutionClass, modelClass);
  if (override) {
    const value = normalizeOverride(override);
    if (value.model) return pick(value.model, value.effort, 'invocation-override');
  }

  const legacyToken = CLASS_ENV_TOKEN[modelClass] || token;
  const surfaceEnv = env[`MOON_RELAY_KERNEL_${upperSurface}_EXECUTION_${token}`]
    || env[`MOON_RELAY_KERNEL_${upperSurface}_${token}`]
    || env[`MOON_RELAY_KERNEL_${upperSurface}_${legacyToken}`];
  const genericEnv = env[`MOON_RELAY_KERNEL_EXECUTION_${token}`]
    || env[`MOON_RELAY_KERNEL_MODEL_${legacyToken}`];

  if (surfaceEnv || genericEnv) {
    const effort = env[`MOON_RELAY_KERNEL_${upperSurface}_EXECUTION_${token}_EFFORT`]
      || env[`MOON_RELAY_KERNEL_${upperSurface}_${token}_EFFORT`]
      || env[`MOON_RELAY_KERNEL_MODEL_${legacyToken}_EFFORT`];
    return pick(surfaceEnv || genericEnv, effort, 'environment');
  }

  const configured = surface
    ? profiles[surface]?.[normalizedExecutionClass] || profiles[surface]?.[modelClass]
    : undefined;
  if (configured?.model) return pick(configured.model, configured.effort, 'profile-config');

  return pick(null, null, 'host-default');
};

export const resolveModelForClass = ({
  surface = null,
  modelClass,
  overrides = {},
  env = process.env,
  profiles = {},
}: ResolveLegacyClassInput = {}): ModelResolution => {
  let executionClass: ExecutionClass | null;
  try {
    executionClass = executionClassFromLegacyModelClass(modelClass);
  } catch (error) {
    throw new Error(`Unknown Kernel model class: ${String(modelClass)}`, { cause: error });
  }
  return resolveModelForExecutionClass({ surface, executionClass, overrides, env, profiles });
};

export const createModelRegistry = ({
  surface = null,
  runtimeHome = null,
  env = process.env,
  configPath = null,
  overrides = {},
}: ModelRegistryOptions = {}) => {
  const profiles = loadModelProfiles({ runtimeHome, env, configPath });
  return Object.freeze({
    surface,
    profiles,
    resolveExecutionClass(
      executionClass: unknown,
      callOverrides: ModelOverrideMap = {},
    ) {
      return resolveModelForExecutionClass({
        surface,
        executionClass,
        overrides: { ...overrides, ...callOverrides },
        env,
        profiles,
      });
    },
    resolve(modelClass: unknown, callOverrides: ModelOverrideMap = {}) {
      return resolveModelForClass({
        surface,
        modelClass,
        overrides: { ...overrides, ...callOverrides },
        env,
        profiles,
      });
    },
  });
};
