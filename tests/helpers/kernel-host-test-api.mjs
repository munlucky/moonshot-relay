import { prepareHostTurn } from '../../scripts/host/kernel/host-turn.mjs';
import { createHostRoutingBridge } from '../../scripts/host/kernel/host-routing.mjs';

const routing = (controlPlane) => createHostRoutingBridge({
  store: controlPlane.stateStore,
  detectStepStagnation: (runId, options) => controlPlane.detectStepStagnation(runId, options),
});

export const prepareTestHostTurn = (controlPlane, runId, options = {}) => prepareHostTurn({
  controlPlane,
  runId,
  ...options,
});

export const decideTestModelRoute = (controlPlane, runId, options = {}) => (
  routing(controlPlane).decideModelRoute(runId, options)
);

export const recommendTestRouting = (controlPlane, runId, options = {}) => (
  routing(controlPlane).recommendRouting(runId, options)
);

export const detectTestStagnation = (controlPlane, runId, options = {}) => routing(controlPlane).detectStagnation(runId, options);

export const testStagnationSignal = (controlPlane, runId) => routing(controlPlane).stagnationSignal(runId);
