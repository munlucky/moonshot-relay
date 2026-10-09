// Conditional Kernel-native guidance for frontend work, browser proof,
// security review, debugging, and simplification. These policies select
// guidance and proof requirements; they never mint a proof/review/completion
// receipt themselves.

const FRONTEND_EXTENSIONS = /\.(?:css|scss|sass|less|html?|jsx?|tsx?|vue|svelte)$/i;
const FRONTEND_PATHS = /(?:^|\/)(?:src|app|components?|pages?|views?|frontend|web|ui)(?:\/|$)/i;
const BROWSER_SIGNALS = /\b(?:browser|web|ui|screen|page|click|tap|form|route|navigation|render|interaction|persist|persistence|recover|recovery|localStorage|sessionStorage|playwright|cypress|selenium|webdriver)\b/i;
const PERSISTENCE_SIGNALS = /\b(?:persist|persistence|save|stored?|reload|refresh|recover|recovery|restore|database|localStorage|sessionStorage|offline)\b/i;
const SECURITY_SIGNALS = /\b(?:auth(?:entication|orization)?|credential|secret|token|password|cookie|session|permission|privilege|untrusted|user input|injection|xss|csrf|dependency|security|sensitive data|high[- ]risk data)\b/i;

const valuesToText = (values = []) => values.map((value) => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value || '');
  return [value.statement, value.acceptance, value.commandRef, value.command, value.scenarioId, value.kind]
    .filter(Boolean).join(' ');
}).join(' ');

export const normalizeChangedPaths = (paths = []) => [...new Set((Array.isArray(paths) ? paths : [])
  .map((value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''))
  .filter(Boolean))].sort();

export const detectFrontendGuidance = ({ changedPaths = [], objective = '', acceptance = [], taskClass = '', flags = {}, surfaces = [] } = {}) => {
  const paths = normalizeChangedPaths(changedPaths);
  const pathSignal = paths.some((value) => FRONTEND_EXTENSIONS.test(value) || FRONTEND_PATHS.test(value));
  const textSignal = BROWSER_SIGNALS.test(`${objective} ${valuesToText(acceptance)}`);
  const active = pathSignal || taskClass === 'ui' || flags.frontend === true || flags.visualBehavior === true || surfaces.includes('frontend');
  return {
    active,
    reasons: [
      pathSignal ? 'frontend-path-or-extension' : null,
      taskClass === 'ui' ? 'ui-task-class' : null,
      flags.frontend === true ? 'frontend-flag' : null,
      flags.visualBehavior === true ? 'visual-behavior-flag' : null,
      surfaces.includes('frontend') ? 'frontend-surface' : null,
      textSignal ? 'browser-facing-contract-language' : null,
    ].filter(Boolean),
    guidance: active ? [
      'preserve existing design context and reuse design-system tokens/components',
      'check responsive and accessibility states',
      'model loading, empty, error, and persistence states explicitly',
      'prefer the smallest behavior-preserving change',
    ] : [],
  };
};

export const resolveBrowserProofPolicy = ({ objective = '', acceptance = [], requiredVerifications = [], projectType = null, flags = {}, surfaces = [] } = {}) => {
  const text = `${objective} ${valuesToText(acceptance)} ${valuesToText(requiredVerifications)}`;
  const explicit = (Array.isArray(requiredVerifications) ? requiredVerifications : []).filter((item) => {
    const candidate = typeof item === 'string' ? item : item?.commandRef || item?.kind || item?.scenarioId || item?.type || '';
    return /browser|playwright|cypress|selenium|webdriver|e2e/i.test(String(candidate));
  });
  const required = explicit.length > 0 || flags.browserProof === true || surfaces.includes('browser')
    || projectType === 'web' || (BROWSER_SIGNALS.test(text) && /\b(?:must|required|should|acceptance|scenario|flow|behavior|interaction)\b/i.test(text));
  const critical = PERSISTENCE_SIGNALS.test(text) && required;
  return {
    required,
    critical,
    reasons: [
      explicit.length > 0 ? 'explicit-browser-verification' : null,
      flags.browserProof === true ? 'browser-proof-flag' : null,
      surfaces.includes('browser') ? 'browser-surface' : null,
      projectType === 'web' ? 'web-project-type' : null,
      required && explicit.length === 0 && BROWSER_SIGNALS.test(text) ? 'browser-facing-acceptance' : null,
      critical ? 'persistence-or-recovery-depth' : null,
    ].filter(Boolean),
    minimumDepth: critical ? 'open-act-mutate-persist-recover' : required ? 'open-act' : null,
    authority: 'kernel-proof-adapter',
  };
};

export const browserEvidenceSatisfiesPolicy = ({ policy, evidenceDepth, metadata = {} } = {}) => {
  if (!policy?.required) return { satisfied: true, reasons: [] };
  const depths = ['smoke', 'open-act', 'open-act-mutate-persist', 'open-act-mutate-persist-recover'];
  const actualIndex = depths.indexOf(String(evidenceDepth || metadata.evidenceDepth || ''));
  const requiredIndex = depths.indexOf(policy.minimumDepth);
  const reasons = [];
  if (actualIndex < 0 || requiredIndex < 0 || actualIndex < requiredIndex) reasons.push('browser-evidence-depth-insufficient');
  for (const field of ['scenarioId', 'target', 'sourceIdentity', 'mutationRevision', 'interactionOutcome', 'artifactRefs', 'timestamp', 'verdict']) {
    if (metadata[field] === undefined || metadata[field] === null || metadata[field] === '') reasons.push(`browser-evidence-${field}-missing`);
  }
  return { satisfied: reasons.length === 0, reasons };
};

export const resolveSecurityReviewPolicy = ({ objective = '', acceptance = [], requiredVerifications = [], changedPaths = [], flags = {}, surfaces = [], risks = [] } = {}) => {
  const text = `${objective} ${valuesToText(acceptance)} ${valuesToText(requiredVerifications)} ${valuesToText(risks)} ${valuesToText(changedPaths)}`;
  const required = flags.securityBoundary === true || flags.authBoundary === true || surfaces.includes('security_boundary') || SECURITY_SIGNALS.test(text);
  return {
    required,
    independentReviewRequired: required,
    reasons: [
      flags.securityBoundary === true ? 'security-boundary-flag' : null,
      flags.authBoundary === true ? 'auth-boundary-flag' : null,
      surfaces.includes('security_boundary') ? 'security-surface' : null,
      SECURITY_SIGNALS.test(text) ? 'security-sensitive-language-or-path' : null,
    ].filter(Boolean),
    requiredVerificationKinds: required ? ['security'] : [],
    authority: 'kernel-review-policy',
  };
};

export const classifyFailureClass = ({ failure = {}, command = '', error = '' } = {}) => {
  const text = `${failure.code || ''} ${failure.failureCategory || ''} ${failure.errorSummary || ''} ${command} ${error}`.toLowerCase();
  if (/timeout|timed out|hung|deadlock/.test(text)) return 'timeout_or_hang';
  if (/assert|expect|snapshot|test failed|e2e/.test(text)) return 'verification_failure';
  if (/compile|type.?check|syntax|module not found|build/.test(text)) return 'build_or_compile';
  if (/permission|access denied|eacces|enoent|spawn|network|provider/.test(text)) return 'infrastructure_or_environment';
  if (/contract|acceptance|scope|provenance|binding/.test(text)) return 'contract_or_scope';
  return 'unknown_failure';
};

export const chooseDebugTactic = ({ failureClass = 'unknown_failure', priorAttempts = [] } = {}) => {
  const sameClass = (Array.isArray(priorAttempts) ? priorAttempts : []).filter((attempt) => attempt.failureClass === failureClass).length;
  const tactic = sameClass === 0
    ? 'reproduce_and_minimize'
    : sameClass === 1
      ? 'instrument_shared_seam'
      : 'replan_or_change_boundary';
  return { failureClass, repeated: sameClass, tactic, stagnated: sameClass >= 2, authority: 'kernel-debug-policy' };
};

// Behavior change alone is not a simplification signal; only added structure
// or an explicit complexity signal is.
export const resolveSimplificationGuidance = ({
  complex = false,
  newDependency = false,
  newAbstraction = false,
  duplicateImplementation = false,
  configurationSurfaceIncreased = false,
} = {}) => {
  const active = complex === true
    || newDependency === true
    || newAbstraction === true
    || duplicateImplementation === true
    || configurationSurfaceIncreased === true;
  return {
    active,
    checks: active ? ['unnecessary-abstraction', 'duplicate-logic', 'scope-expansion', 'speculative-configuration'] : [],
    authority: 'kernel-guidance-only',
  };
};

export const resolveDomainPolicies = (input = {}) => ({
  frontend: detectFrontendGuidance(input),
  browser: resolveBrowserProofPolicy(input),
  security: resolveSecurityReviewPolicy(input),
  simplification: resolveSimplificationGuidance(input),
});
