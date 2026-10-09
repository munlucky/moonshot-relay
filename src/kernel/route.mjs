import { floorForSurface } from './risk-surfaces.mjs';
import { readProjectTrackSync } from './runtime-home.mjs';
import { resolveKernelCapabilities } from './capability-resolver.mjs';

const rank = { T0: 0, T1: 1, T2: 2, T3: 3 };

export const classifyRisk = (task = {}) => {
  let tier = task.behaviorChanging ? 'T1' : 'T0';
  for (const surface of task.surfaces || []) {
    const floor = floorForSurface(surface);
    if (floor && rank[tier] < rank[floor]) tier = floor;
  }
  return tier;
};

export const routeTask = (task = {}, { projectRoot = process.cwd() } = {}) => {
  const effectiveTrack = readProjectTrackSync(projectRoot);
  if (effectiveTrack !== 'kernel') return { status: 'wrong_harness', requestedTrack: 'kernel', activeTrack: effectiveTrack || 'unknown', route: [] };
  const riskTier = task.riskTier || classifyRisk(task);
  const taskClass = task.taskClass || 'feature';
  let route;
  if (taskClass === 'analysis') route = ['FRAME', 'CLOSE'];
  else route = ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'];
  const capabilityDecision = resolveKernelCapabilities({ ...task, taskClass, riskTier, route });
  return { status: 'ready', taskClass, riskTier, ambiguity: Boolean(task.ambiguityChangesOutcome), capabilities: capabilityDecision.selected.map((entry) => entry.id), capabilityDecision, route };
};
