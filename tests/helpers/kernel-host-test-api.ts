import { prepareHostTurn } from '../../src/host/kernel/host-turn.js';
import { createHostRoutingBridge } from '../../src/host/kernel/host-routing.js';

import type { createKernelControlPlane } from '../../src/host/kernel/control-plane-runtime.js';

type TestControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
const routing = (controlPlane: TestControlPlane) => createHostRoutingBridge({
  controlPlane,
  detectStepStagnation: (runId) => controlPlane.detectStepStagnation(runId),
});

export const prepareTestHostTurn = (controlPlane: TestControlPlane, runId: string, options: Omit<Parameters<typeof prepareHostTurn>[0], 'controlPlane' | 'runId'> = {}) => prepareHostTurn({
  controlPlane,
  runId,
  ...options,
});

export const decideTestModelRoute = (controlPlane: TestControlPlane, runId: string, options: Parameters<ReturnType<typeof routing>['decideModelRoute']>[1] = {}) => (
  routing(controlPlane).decideModelRoute(runId, options)
);

export const recommendTestRouting = (controlPlane: TestControlPlane, runId: string, options: Parameters<ReturnType<typeof routing>['recommendRouting']>[1] = {}) => (
  routing(controlPlane).recommendRouting(runId, options)
);

export const detectTestStagnation = (controlPlane: TestControlPlane, runId: string, options: Parameters<ReturnType<typeof routing>['detectStagnation']>[1] = {}) => routing(controlPlane).detectStagnation(runId, options);

export const testStagnationSignal = (controlPlane: TestControlPlane, runId: string) => routing(controlPlane).stagnationSignal(runId);
