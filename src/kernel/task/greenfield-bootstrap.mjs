// Greenfield bootstrap (§15): the first implementation of a new project is a
// runnable minimal vertical slice (a "walking skeleton"), not full scaffolding.
// This module plans that slice and states the completion evidence a given
// project type must produce (§15.6). It is guidance the model consumes, never
// a forced multi-step procedure.

// Design only expands past the walking skeleton when one of these is present
// (§15.3); otherwise the first slice is implemented directly.
const DESIGN_EXPANSION_SIGNALS = [
  'multipleComponents',
  'database',
  'authBoundary',
  'externalApi',
  'asyncProcessing',
  'deploymentTarget',
  'irreversibleTechChoice',
];

// Project-type -> the mandatory completion evidence (§15.6 table).
const REQUIRED_EVIDENCE_BY_TYPE = {
  cli: { kind: 'cli-smoke', description: 'Actually run the command and assert its output.' },
  api: { kind: 'api-scenario', description: 'Exercise a real request/response contract.' },
  web: { kind: 'browser-scenario', description: 'Drive the core user scenario in a browser.' },
  library: { kind: 'public-import', description: 'Import and use the public surface.' },
  data: { kind: 'data-pipeline', description: 'Run input -> processing -> output end to end.' },
  deploy: { kind: 'deployment-smoke', description: 'Package or deploy-smoke the target.' },
};

export const requiredEvidenceForProjectType = (projectType = 'library') => REQUIRED_EVIDENCE_BY_TYPE[projectType] || REQUIRED_EVIDENCE_BY_TYPE.library;

export const needsExpandedDesign = (taskContract = {}) => {
  const risk = taskContract.risk && typeof taskContract.risk === 'object' ? taskContract.risk : {};
  return DESIGN_EXPANSION_SIGNALS.some((signal) => taskContract[signal] === true || risk[signal] === true);
};

export const planWalkingSkeleton = ({ projectType = 'library', objective = '', taskContract = {} } = {}) => {
  const evidence = requiredEvidenceForProjectType(projectType);
  return {
    schemaVersion: 1,
    projectType,
    objective,
    expandedDesign: needsExpandedDesign(taskContract),
    // The minimal runnable flow every walking skeleton must realize.
    slice: [
      'user-input',
      'application-boundary',
      'core-business-action',
      'store-or-minimal-mock',
      'return-result',
      'real-verification',
    ],
    requiredEvidence: evidence,
    minimumCompletion: [
      'dependency-resolution',
      'build',
      'core-user-scenario',
      'acceptance-evidence-coverage',
      'documented-run-method',
      evidence.kind,
    ],
  };
};
