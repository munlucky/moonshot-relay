// Greenfield bootstrap (§15): the first implementation of a new project is a
// runnable minimal vertical slice (a "walking skeleton"), not full scaffolding.

const DESIGN_EXPANSION_SIGNALS = [
  'multipleComponents',
  'database',
  'authBoundary',
  'externalApi',
  'asyncProcessing',
  'deploymentTarget',
  'irreversibleTechChoice',
] as const;

const REQUIRED_EVIDENCE_BY_TYPE = {
  cli: { kind: 'cli-smoke', description: 'Actually run the command and assert its output.' },
  api: { kind: 'api-scenario', description: 'Exercise a real request/response contract.' },
  web: { kind: 'browser-scenario', description: 'Drive the core user scenario in a browser.' },
  library: { kind: 'public-import', description: 'Import and use the public surface.' },
  data: { kind: 'data-pipeline', description: 'Run input -> processing -> output end to end.' },
  deploy: { kind: 'deployment-smoke', description: 'Package or deploy-smoke the target.' },
} as const;

export type GreenfieldProjectType = keyof typeof REQUIRED_EVIDENCE_BY_TYPE;
export type GreenfieldEvidence = typeof REQUIRED_EVIDENCE_BY_TYPE[GreenfieldProjectType];

export interface GreenfieldTaskContract extends Record<string, unknown> {
  risk?: Record<string, unknown> | null;
}

export interface WalkingSkeletonPlan {
  schemaVersion: 1;
  projectType: string;
  objective: string;
  expandedDesign: boolean;
  slice: string[];
  requiredEvidence: GreenfieldEvidence;
  minimumCompletion: string[];
}

const isProjectType = (value: unknown): value is GreenfieldProjectType => (
  typeof value === 'string' && Object.hasOwn(REQUIRED_EVIDENCE_BY_TYPE, value)
);

export const requiredEvidenceForProjectType = (
  projectType: unknown = 'library',
): GreenfieldEvidence => (
  isProjectType(projectType)
    ? REQUIRED_EVIDENCE_BY_TYPE[projectType]
    : REQUIRED_EVIDENCE_BY_TYPE.library
);

export const needsExpandedDesign = (
  taskContract: GreenfieldTaskContract = {},
): boolean => {
  const risk = taskContract.risk && typeof taskContract.risk === 'object'
    ? taskContract.risk
    : {};
  return DESIGN_EXPANSION_SIGNALS.some(
    (signal) => taskContract[signal] === true || risk[signal] === true,
  );
};

export const planWalkingSkeleton = ({
  projectType = 'library',
  objective = '',
  taskContract = {},
}: {
  projectType?: unknown;
  objective?: unknown;
  taskContract?: GreenfieldTaskContract;
} = {}): WalkingSkeletonPlan => {
  const evidence = requiredEvidenceForProjectType(projectType);
  return {
    schemaVersion: 1,
    projectType: String(projectType || 'library'),
    objective: String(objective || ''),
    expandedDesign: needsExpandedDesign(taskContract),
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
