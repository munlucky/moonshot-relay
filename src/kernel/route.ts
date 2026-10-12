import { floorForSurface } from './risk-surfaces.js';
import { readProjectTrackSync } from './runtime-home.js';
import { resolveKernelCapabilities } from './capability-resolver.js';

type RiskTier = 'T0' | 'T1' | 'T2' | 'T3';

export interface RouteTaskInput extends Record<string, unknown> {
  behaviorChanging?: boolean;
  surfaces?: unknown[];
  riskTier?: RiskTier;
  taskClass?: string;
  ambiguityChangesOutcome?: boolean;
}

interface CapabilitySelection {
  id: string;
}

interface CapabilityDecisionLike {
  selected: CapabilitySelection[];
  [key: string]: unknown;
}

const resolveCapabilities = resolveKernelCapabilities;

const rank: Record<RiskTier, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export const classifyRisk = (task: RouteTaskInput = {}): RiskTier => {
  let tier: RiskTier = task.behaviorChanging ? 'T1' : 'T0';
  for (const surface of task.surfaces || []) {
    const floor = floorForSurface(surface);
    if (floor && rank[tier] < rank[floor]) tier = floor;
  }
  return tier;
};

export const routeTask = (
  task: RouteTaskInput = {},
  { projectRoot = process.cwd() }: { projectRoot?: string } = {},
) => {
  const effectiveTrack = readProjectTrackSync(projectRoot);
  if (effectiveTrack !== 'kernel') {
    return {
      status: 'wrong_harness',
      requestedTrack: 'kernel',
      activeTrack: effectiveTrack || 'unknown',
      route: [],
    };
  }

  const riskTier = task.riskTier || classifyRisk(task);
  const taskClass = task.taskClass || 'feature';
  const route = taskClass === 'analysis'
    ? ['FRAME', 'CLOSE']
    : ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'];
  const capabilityDecision = resolveCapabilities({
    ...task,
    taskClass,
    riskTier,
    route,
  });

  return {
    status: 'ready',
    taskClass,
    riskTier,
    ambiguity: Boolean(task.ambiguityChangesOutcome),
    capabilities: capabilityDecision.selected.map((entry) => entry.id),
    capabilityDecision,
    route,
  };
};
