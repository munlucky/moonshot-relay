// Control Plane coordinator surface (Wave B9).
//
// `next` and `report` are the only model-facing lifecycle operations.  Host
// routing, prompt compilation, leases, and persistence remain internal or
// Host-owned implementation details.  Keeping this as a tiny structural
// contract makes accidental public command growth testable without creating a
// second workflow engine.

export const COORDINATOR_SURFACE_SCHEMA_VERSION = 1;
export const COORDINATOR_COMMANDS = Object.freeze(['next', 'report']);

export const buildCoordinatorSurface = ({ next, report } = {}) => {
  if (typeof next !== 'function' || typeof report !== 'function') {
    throw new TypeError('coordinator surface requires next and report functions');
  }
  return Object.freeze({
    schemaVersion: COORDINATOR_SURFACE_SCHEMA_VERSION,
    commands: COORDINATOR_COMMANDS,
    next,
    report,
  });
};

export const coordinatorSurfaceKeys = (surface) => Object.keys(surface || {}).sort();
