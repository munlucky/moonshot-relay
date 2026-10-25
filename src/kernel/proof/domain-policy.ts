type UnknownRecord = Record<string, unknown>;

export interface DomainPolicyInput extends UnknownRecord {
  changedPaths?: unknown[];
  objective?: unknown;
  acceptance?: unknown[];
  requiredVerifications?: unknown[];
  taskClass?: unknown;
  flags?: Record<string, boolean>;
  surfaces?: string[];
  projectType?: string | null;
  risks?: unknown[];
  complex?: boolean;
  newDependency?: boolean;
  newAbstraction?: boolean;
  duplicateImplementation?: boolean;
  configurationSurfaceIncreased?: boolean;
}

export interface BrowserProofPolicy {
  required: boolean;
  critical: boolean;
  reasons: string[];
  minimumDepth: string | null;
  authority: 'kernel-proof-adapter';
}

export interface FailureInput {
  code?: unknown;
  failureCategory?: unknown;
  errorSummary?: unknown;
  [key: string]: unknown;
}

export interface PriorDebugAttempt {
  failureClass?: string;
  [key: string]: unknown;
}

const FRONTEND_EXTENSIONS = /\.(?:css|scss|sass|less|html?|jsx?|tsx?|vue|svelte)$/i;
const FRONTEND_PATHS = /(?:^|\/)(?:src|app|components?|pages?|views?|frontend|web|ui)(?:\/|$)/i;
const BROWSER_SIGNALS = /\b(?:browser|web|ui|screen|page|click|tap|form|route|navigation|render|interaction|persist|persistence|recover|recovery|localStorage|sessionStorage|playwright|cypress|selenium|webdriver)\b/i;
const PERSISTENCE_SIGNALS = /\b(?:persist|persistence|save|stored?|reload|refresh|recover|recovery|restore|database|localStorage|sessionStorage|offline)\b/i;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const valuesToText = (values: unknown[] = []): string => values
  .map((value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return String(value || '');
    const record = asRecord(value);
    return [
      record.statement,
      record.acceptance,
      record.commandRef,
      record.command,
      record.scenarioId,
      record.kind,
    ].filter(Boolean).join(' ');
  })
  .join(' ');

export const normalizeChangedPaths = (
  paths: unknown[] = [],
): string[] => [...new Set(
  (Array.isArray(paths) ? paths : [])
    .map((value) => String(value || '')
      .replaceAll('\\', '/')
      .replace(/^\.\//, ''))
    .filter(Boolean),
)].sort();

export const detectFrontendGuidance = ({
  changedPaths = [],
  objective = '',
  acceptance = [],
  taskClass = '',
  flags = {},
  surfaces = [],
}: DomainPolicyInput = {}) => {
  const paths = normalizeChangedPaths(changedPaths);
  const pathSignal = paths.some((value) => (
    FRONTEND_EXTENSIONS.test(value) || FRONTEND_PATHS.test(value)
  ));
  const objectiveText = String(objective || '');
  const taskClassText = String(taskClass || '');
  const textSignal = BROWSER_SIGNALS.test(
    `${objectiveText} ${valuesToText(acceptance)}`,
  );
  const active = pathSignal
    || taskClassText === 'ui'
    || flags.frontend === true
    || flags.visualBehavior === true
    || surfaces.includes('frontend');

  return {
    active,
    reasons: [
      pathSignal ? 'frontend-path-or-extension' : null,
      taskClassText === 'ui' ? 'ui-task-class' : null,
      flags.frontend === true ? 'frontend-flag' : null,
      flags.visualBehavior === true ? 'visual-behavior-flag' : null,
      surfaces.includes('frontend') ? 'frontend-surface' : null,
      textSignal ? 'browser-facing-contract-language' : null,
    ].filter((value): value is string => Boolean(value)),
    guidance: active
      ? [
          'preserve existing design context and reuse design-system tokens/components',
          'check responsive and accessibility states',
          'model loading, empty, error, and persistence states explicitly',
          'prefer the smallest behavior-preserving change',
        ]
      : [],
  };
};

export const resolveBrowserProofPolicy = ({
  objective = '',
  acceptance = [],
  requiredVerifications = [],
  projectType = null,
  flags = {},
  surfaces = [],
}: DomainPolicyInput = {}): BrowserProofPolicy => {
  const text = `${String(objective || '')} ${valuesToText(acceptance)} ${valuesToText(requiredVerifications)}`;
  const explicit = requiredVerifications.filter((item) => {
    const record = asRecord(item);
    const candidate = typeof item === 'string'
      ? item
      : record.commandRef || record.kind || record.scenarioId || record.type || '';
    return /browser|playwright|cypress|selenium|webdriver|e2e/i.test(
      String(candidate),
    );
  });

  const required = explicit.length > 0
    || flags.browserProof === true
    || surfaces.includes('browser')
    || projectType === 'web'
    || (
      BROWSER_SIGNALS.test(text)
      && /\b(?:must|required|should|acceptance|scenario|flow|behavior|interaction)\b/i.test(text)
    );
  const critical = PERSISTENCE_SIGNALS.test(text) && required;

  return {
    required,
    critical,
    reasons: [
      explicit.length > 0 ? 'explicit-browser-verification' : null,
      flags.browserProof === true ? 'browser-proof-flag' : null,
      surfaces.includes('browser') ? 'browser-surface' : null,
      projectType === 'web' ? 'web-project-type' : null,
      required && explicit.length === 0 && BROWSER_SIGNALS.test(text)
        ? 'browser-facing-acceptance'
        : null,
      critical ? 'persistence-or-recovery-depth' : null,
    ].filter((value): value is string => Boolean(value)),
    minimumDepth: critical
      ? 'open-act-mutate-persist-recover'
      : required
        ? 'open-act'
        : null,
    authority: 'kernel-proof-adapter',
  };
};

export const browserEvidenceSatisfiesPolicy = ({
  policy,
  evidenceDepth,
  metadata = {},
}: {
  policy?: BrowserProofPolicy | null;
  evidenceDepth?: unknown;
  metadata?: UnknownRecord;
} = {}) => {
  if (!policy?.required) return { satisfied: true, reasons: [] as string[] };

  const depths = [
    'smoke',
    'open-act',
    'open-act-mutate-persist',
    'open-act-mutate-persist-recover',
  ];
  const actualIndex = depths.indexOf(
    String(evidenceDepth || metadata.evidenceDepth || ''),
  );
  const requiredIndex = depths.indexOf(String(policy.minimumDepth || ''));
  const reasons: string[] = [];

  if (
    actualIndex < 0
    || requiredIndex < 0
    || actualIndex < requiredIndex
  ) {
    reasons.push('browser-evidence-depth-insufficient');
  }

  for (const field of [
    'scenarioId',
    'target',
    'sourceIdentity',
    'mutationRevision',
    'interactionOutcome',
    'artifactRefs',
    'timestamp',
    'verdict',
  ]) {
    if (
      metadata[field] === undefined
      || metadata[field] === null
      || metadata[field] === ''
    ) {
      reasons.push(`browser-evidence-${field}-missing`);
    }
  }

  return { satisfied: reasons.length === 0, reasons };
};

export const resolveSecurityReviewPolicy = ({
  flags = {},
  surfaces = [],
}: DomainPolicyInput = {}) => {
  const required = flags.securityBoundary === true
    || flags.authBoundary === true
    || surfaces.includes('security_boundary');

  return {
    required,
    independentReviewRequired: required,
    reasons: [
      flags.securityBoundary === true ? 'security-boundary-flag' : null,
      flags.authBoundary === true ? 'auth-boundary-flag' : null,
      surfaces.includes('security_boundary') ? 'security-surface' : null,
    ].filter((value): value is string => Boolean(value)),
    requiredVerificationKinds: required ? ['security'] : [],
    authority: 'kernel-review-policy' as const,
  };
};

export const classifyFailureClass = ({
  failure = {},
  command = '',
  error = '',
}: {
  failure?: FailureInput;
  command?: unknown;
  error?: unknown;
} = {}): string => {
  const text = [
    failure.code || '',
    failure.failureCategory || '',
    failure.errorSummary || '',
    command,
    error,
  ].map(String).join(' ').toLowerCase();

  if (/timeout|timed out|hung|deadlock/.test(text)) return 'timeout_or_hang';
  if (/assert|expect|snapshot|test failed|e2e/.test(text)) {
    return 'verification_failure';
  }
  if (/compile|type.?check|syntax|module not found|build/.test(text)) {
    return 'build_or_compile';
  }
  if (/permission|access denied|eacces|enoent|spawn|network|provider/.test(text)) {
    return 'infrastructure_or_environment';
  }
  if (/contract|acceptance|scope|provenance|binding/.test(text)) {
    return 'contract_or_scope';
  }
  return 'unknown_failure';
};

export const chooseDebugTactic = ({
  failureClass = 'unknown_failure',
  priorAttempts = [],
}: {
  failureClass?: string;
  priorAttempts?: PriorDebugAttempt[];
} = {}) => {
  const sameClass = priorAttempts.filter(
    (attempt) => attempt.failureClass === failureClass,
  ).length;
  const tactic = sameClass === 0
    ? 'reproduce_and_minimize'
    : sameClass === 1
      ? 'instrument_shared_seam'
      : 'replan_or_change_boundary';

  return {
    failureClass,
    repeated: sameClass,
    tactic,
    stagnated: sameClass >= 2,
    authority: 'kernel-debug-policy' as const,
  };
};

export const resolveSimplificationGuidance = ({
  complex = false,
  newDependency = false,
  newAbstraction = false,
  duplicateImplementation = false,
  configurationSurfaceIncreased = false,
}: DomainPolicyInput = {}) => {
  const active = complex === true
    || newDependency === true
    || newAbstraction === true
    || duplicateImplementation === true
    || configurationSurfaceIncreased === true;

  return {
    active,
    checks: active
      ? [
          'unnecessary-abstraction',
          'duplicate-logic',
          'scope-expansion',
          'speculative-configuration',
        ]
      : [],
    authority: 'kernel-guidance-only' as const,
  };
};

export const resolveDomainPolicies = (
  input: DomainPolicyInput = {},
) => ({
  frontend: detectFrontendGuidance(input),
  browser: resolveBrowserProofPolicy(input),
  security: resolveSecurityReviewPolicy(input),
  simplification: resolveSimplificationGuidance(input),
});
