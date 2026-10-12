import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { evidenceBinding, normalizeCandidateId, sha256Hex } from './candidate-identity.js';
import {
  classifyFinding,
  normalizeReviewCritiqueLoopReceipt,
  repairLoopBlockers,
  reviewCritiqueLoopBlockers,
} from './review-bundle.mjs';

export const VERIFICATION_PLANE_SCHEMA_VERSION = 1;

export const REQUIRED_VERIFICATION_PLANES = [
  'unit',
  'package',
  'installer',
  'browser',
  'security',
  'quality',
];

export const COMPLETION_AUTHORITY_REQUIRED_PLANES = REQUIRED_VERIFICATION_PLANES;

export const BROWSER_COMPLETION_STATUSES = [
  'clean_pass',
  'flaky_pass',
  'failed',
  'setup_gap',
];

export const BROWSER_COMPLETION_FAILURE_CLASSES = [
  'none',
  'static_gate_failed',
  'build_failed',
  'preview_start_failed',
  'fixture_setup_failed',
  'playwright_assertion_failed',
  'browser_confirmation_failed',
  'artifact_missing',
  'runtime_environment_failed',
  'setup_gap',
  'stale_evidence',
];

export const VERIFICATION_PROFILES = {
  prompt_only: ['quality'],
  docs_only: ['package', 'quality'],
  script_change: ['unit', 'quality'],
  workflow_core: ['unit', 'package', 'installer', 'security', 'quality'],
  runtime_adapter: COMPLETION_AUTHORITY_REQUIRED_PLANES,
};

export const REQUIRED_SECURITY_SCANS = [
  'codeql',
  'dependencyReview',
  'dependabot',
  'secretScanning',
];

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

const nowIso = () => new Date().toISOString();

const parseDate = (value) => {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
};

const firstReason = (...values) => values.find((value) => String(value || '').trim()) || '';

const toBool = (value) => value === true;

const normalizeTaskType = (value) => String(value || '').trim().toLowerCase().replaceAll('-', '_');

const defaultWaiver = (waiver = {}) => ({
  allowed: toBool(waiver.allowed),
  reason: String(waiver.reason || ''),
  approvedBy: String(waiver.approvedBy || ''),
});

function classifyFromTaskType(taskType) {
  if (/^(docs_only|documentation|markdown|prompt_only)$/.test(taskType)) {
    return {
      status: 'classified',
      requiresBrowserEvidence: false,
      requiresIntegrationEvidence: false,
      criticalScenario: false,
      reason: 'docs-only task does not require browser or integration evidence by default',
    };
  }
  if (/^(ui|frontend|front_end|browser|visual|component|route_ui)$/.test(taskType)) {
    return {
      status: 'classified',
      requiresBrowserEvidence: true,
      requiresIntegrationEvidence: false,
      criticalScenario: true,
      reason: 'ui/frontend task requires browser evidence by default',
    };
  }
  if (/^(route|api|integration|route_api|backend_integration)$/.test(taskType)) {
    return {
      status: 'classified',
      requiresBrowserEvidence: false,
      requiresIntegrationEvidence: true,
      criticalScenario: true,
      reason: 'route/API integration task requires integration evidence by default',
    };
  }
  return {
    status: 'needs_classification',
    requiresBrowserEvidence: true,
    requiresIntegrationEvidence: true,
    criticalScenario: true,
    reason: 'unknown task type requires explicit classification before clean completion',
  };
}

export function classifyTaskVerification(input = {}) {
  const taskType = normalizeTaskType(input.taskType || input.changeType || input.kind);
  const inferred = classifyFromTaskType(taskType);
  const hasExplicitBrowser = Object.hasOwn(input, 'requiresBrowserEvidence');
  const hasExplicitIntegration = Object.hasOwn(input, 'requiresIntegrationEvidence');
  const hasExplicitCritical = Object.hasOwn(input, 'criticalScenario');
  const waiver = defaultWaiver(input.waiver);
  const waiverComplete = waiver.allowed && waiver.reason && waiver.approvedBy;
  const explicitClassification = hasExplicitBrowser || hasExplicitIntegration || hasExplicitCritical;
  const status = inferred.status === 'needs_classification' && explicitClassification
    ? 'classified'
    : inferred.status;
  const requiresBrowserEvidence = hasExplicitBrowser ? toBool(input.requiresBrowserEvidence) : inferred.requiresBrowserEvidence;
  const requiresIntegrationEvidence = hasExplicitIntegration ? toBool(input.requiresIntegrationEvidence) : inferred.requiresIntegrationEvidence;
  const criticalScenario = hasExplicitCritical ? toBool(input.criticalScenario) : inferred.criticalScenario;
  const waiverInvalid = waiver.allowed && !waiverComplete;
  const evidenceRequired = (requiresBrowserEvidence || requiresIntegrationEvidence) && !waiverComplete;
  const completionBlocked = status === 'needs_classification' || waiverInvalid;

  return {
    schemaVersion: VERIFICATION_PLANE_SCHEMA_VERSION,
    taskType: taskType || 'unknown',
    status,
    requiresBrowserEvidence,
    requiresIntegrationEvidence,
    criticalScenario,
    waiver,
    failClosed: status === 'needs_classification' || evidenceRequired,
    evidenceRequired,
    completionBlocked,
    reason: waiverInvalid
      ? 'waiver is incomplete'
      : inferred.reason,
    completionAuthority: false,
    authoritySource: 'classification_evidence_only',
  };
}

export function buildBrowserCompletionResult({
  runId,
  goalId,
  scenarioId,
  status = 'failed',
  failedStage = '',
  failureClass = 'artifact_missing',
  evidenceDepth = 'smoke',
  sourceFingerprint = '',
  commands = [],
  artifacts = [],
  repairPromptPath = '',
  setupGap = false,
  artifactSha256 = '',
  generatedAt = nowIso(),
  producerCommand = 'node scripts/verification-plane.mjs browser-result',
  staleStatus = 'fresh',
  runtimeDecisionRef = '',
  redactionManifest = {},
  taskVerificationClass = null,
} = {}) {
  const normalizedStatus = BROWSER_COMPLETION_STATUSES.includes(status) ? status : 'failed';
  const normalizedFailureClass = BROWSER_COMPLETION_FAILURE_CLASSES.includes(failureClass) ? failureClass : 'browser_confirmation_failed';
  const taskClass = taskVerificationClass ? classifyTaskVerification(taskVerificationClass) : null;
  const criticalSmokeOnly = Boolean(taskClass?.criticalScenario && evidenceDepth === 'smoke' && normalizedStatus === 'clean_pass');
  const redactionValues = collectRedactionValues({ commands, redactionManifest });
  return {
    schemaVersion: 1,
    artifactId: 'BROWSER_COMPLETION_RESULT',
    runId,
    goalId,
    scenarioId,
    status: normalizedStatus,
    failedStage,
    failureClass: normalizedFailureClass,
    evidenceDepth,
    sourceFingerprint,
    commands: sanitizeCommandEvidenceList(commands, redactionValues),
    artifacts: sanitizeJsonValue(artifacts, redactionValues),
    repairPromptPath,
    setupGap: toBool(setupGap) || normalizedStatus === 'setup_gap' || normalizedFailureClass === 'setup_gap',
    completionAuthority: false,
    authoritySource: 'evidence_only',
    artifactSha256,
    generatedAt,
    producerCommand,
    staleStatus,
    runtimeDecisionRef,
    redactionManifest: sanitizeJsonValue(redactionManifest, redactionValues),
    taskVerificationClass: taskClass,
    criticalSmokeOnlyWarning: criticalSmokeOnly,
  };
}

const PLAYWRIGHT_REQUIRED_ARTIFACT_TYPES = ['screenshot', 'trace', 'console', 'network', 'report'];
const SUPPORTED_BROWSER_CONFIRMATION_BACKENDS = ['agent-browser', 'playwright-mcp', 'browserctl'];
const SECRET_VALUE_PATTERN = /[A-Za-z0-9_-]*(?:token|secret|password|apikey|api_key|private)[A-Za-z0-9_=-]*/gi;
const SECRET_KEY_PATTERN = /TOKEN|SECRET|PASSWORD|AUTH|API[_-]?KEY|PRIVATE/i;

const collectRedactionValues = (...inputs) => {
  const values = new Set();
  const visit = (value, key = '') => {
    if (Array.isArray(value)) {
      if (key === 'redactValues') {
        for (const item of value) {
          if (typeof item === 'string' && item.length >= 4) values.add(item);
        }
      }
      value.forEach((item) => visit(item, key));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey);
      }
      return;
    }
    if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length >= 4) {
      values.add(value);
    }
  };
  inputs.forEach((input) => visit(input));
  return [...values].sort((a, b) => b.length - a.length);
};

const redactPlaywrightText = (value, exactValues = []) => {
  let redacted = String(value || '');
  for (const exactValue of exactValues) {
    redacted = redacted.split(exactValue).join('[REDACTED]');
  }
  return redacted.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
};

const sanitizeJsonValue = (value, exactValues = []) => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, exactValues));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'env')
        .map(([key, entry]) => [key, sanitizeJsonValue(entry, exactValues)]),
    );
  }
  return typeof value === 'string' ? redactPlaywrightText(value, exactValues) : value;
};

const sanitizeCommandEvidenceList = (commands = [], exactValues = []) => commands.map((command) => ({
  command: redactPlaywrightText(command?.command || '', exactValues),
  stdout: redactPlaywrightText(command?.stdout || '', exactValues),
  stderr: redactPlaywrightText(command?.stderr || '', exactValues),
  exitCode: Number.isFinite(Number(command?.exitCode)) ? Number(command.exitCode) : null,
}));

const normalizeArtifactEntry = (entry, repoRoot = process.cwd(), redactionValues = []) => {
  const artifactPath = String(entry?.path || entry?.artifactPath || '').replaceAll('\\', '/');
  const artifactRoot = path.resolve(repoRoot, '.moonshot-relay', 'browser-artifacts');
  const absoluteArtifactPath = path.resolve(repoRoot, artifactPath);
  const relativeToArtifactRoot = path.relative(artifactRoot, absoluteArtifactPath);
  const pathAllowed = Boolean(relativeToArtifactRoot)
    && !relativeToArtifactRoot.startsWith('..')
    && !path.isAbsolute(relativeToArtifactRoot);
  const exists = entry?.exists === false
    ? false
    : (artifactPath && pathAllowed ? existsSync(absoluteArtifactPath) : false);
  return {
    type: String(entry?.type || entry?.kind || '').trim(),
    path: redactPlaywrightText(artifactPath, redactionValues),
    required: entry?.required !== false,
    exists,
    pathAllowed,
    sha256: String(entry?.sha256 || ''),
  };
};

const normalizeConsoleEntry = (entry, redactionValues = []) => ({
  level: String(entry?.level || entry?.type || '').toLowerCase(),
  text: redactPlaywrightText(entry?.text || entry?.message || '', redactionValues),
  critical: toBool(entry?.critical),
});

const normalizeNetworkEntry = (entry, redactionValues = []) => ({
  url: redactPlaywrightText(entry?.url || '', redactionValues),
  status: Number(entry?.status || entry?.statusCode || 0),
  method: String(entry?.method || 'GET'),
  failed: toBool(entry?.failed) || Boolean(entry?.errorText),
  errorText: redactPlaywrightText(entry?.errorText || '', redactionValues),
});

export function normalizePlaywrightResult({
  repoRoot = process.cwd(),
  runId,
  goalId,
  scenarioId,
  scenario = {},
  result = {},
  taskVerificationClass = null,
  generatedAt = nowIso(),
} = {}) {
  const redactionValues = collectRedactionValues(result, scenario);
  const depth = String(scenario.evidenceDepth || scenario.depth || result.evidenceDepth || 'smoke');
  const artifacts = (result.artifacts || []).map((artifact) => normalizeArtifactEntry(artifact, repoRoot, redactionValues));
  const artifactTypes = new Set(artifacts.filter((artifact) => artifact.path && artifact.exists && artifact.pathAllowed).map((artifact) => artifact.type));
  const requiredTypes = new Set([
    ...PLAYWRIGHT_REQUIRED_ARTIFACT_TYPES,
    ...((scenario.requiredArtifactTypes || result.requiredArtifactTypes || []).map(String)),
  ]);
  if (scenario.videoEnabled || result.videoEnabled) {
    requiredTypes.add('video');
  }

  const missingArtifactTypes = [...requiredTypes].filter((type) => !artifactTypes.has(type));
  const invalidArtifactPaths = artifacts.filter((artifact) => artifact.path && !artifact.pathAllowed).map((artifact) => artifact.path);
  const consoleEntries = (result.console || result.consoleLog || []).map((entry) => normalizeConsoleEntry(entry, redactionValues));
  const networkEntries = (result.network || result.networkLog || []).map((entry) => normalizeNetworkEntry(entry, redactionValues));
  const criticalConsole = consoleEntries.filter((entry) => entry.critical || ['error', 'pageerror'].includes(entry.level));
  const failedNetwork = networkEntries.filter((entry) => entry.failed || entry.status >= 500);
  const assertionFailures = (result.assertions || []).filter((assertion) => assertion?.status === 'failed' || assertion?.passed === false);
  const retryCount = Number(result.retryCount || result.retries || 0);
  const integrationDepth = /integration|open-act|mutate|persist|recover/.test(depth);
  const determinismRequired = toBool(scenario.determinismRequired) || integrationDepth;
  const deterministicSelectors = result.deterministicSelectors === true;
  const fixedTime = result.fixedTime === true;
  const uncontrolledNetworkBlocked = result.uncontrolledNetworkBlocked === true;
  const determinismMissing = determinismRequired && (!deterministicSelectors || !fixedTime || !uncontrolledNetworkBlocked);
  const baseCommands = Array.isArray(result.commands) ? result.commands : [];
  const commands = [
    ...baseCommands,
    {
      command: redactPlaywrightText(result.command || 'playwright', redactionValues),
      stdout: redactPlaywrightText(result.stdout || '', redactionValues),
      stderr: redactPlaywrightText(result.stderr || '', redactionValues),
      exitCode: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
    },
  ].filter((command) => command.command || command.stdout || command.stderr).map((command) => ({
    command: redactPlaywrightText(command.command, redactionValues),
    stdout: redactPlaywrightText(command.stdout, redactionValues),
    stderr: redactPlaywrightText(command.stderr, redactionValues),
    exitCode: Number.isFinite(Number(command.exitCode)) ? Number(command.exitCode) : null,
  }));

  let status = result.status === 'passed' || result.status === 'clean_pass' ? 'clean_pass' : 'failed';
  let failedStage = '';
  let failureClass = 'none';

  if (result.status === 'setup_gap') {
    status = 'setup_gap';
    failedStage = result.failedStage || 'setup';
    failureClass = BROWSER_COMPLETION_FAILURE_CLASSES.includes(result.failureClass) ? result.failureClass : 'setup_gap';
  } else if (missingArtifactTypes.length > 0 || invalidArtifactPaths.length > 0) {
    status = 'failed';
    failedStage = 'artifact';
    failureClass = 'artifact_missing';
  } else if (determinismMissing) {
    status = 'setup_gap';
    failedStage = 'determinism';
    failureClass = 'runtime_environment_failed';
  } else if (criticalConsole.length > 0) {
    status = 'failed';
    failedStage = 'console';
    failureClass = 'playwright_assertion_failed';
  } else if (failedNetwork.length > 0) {
    status = 'failed';
    failedStage = 'network';
    failureClass = 'playwright_assertion_failed';
  } else if (assertionFailures.length > 0 || result.status === 'failed') {
    status = 'failed';
    failedStage = 'assertion';
    failureClass = 'playwright_assertion_failed';
  } else if (retryCount > 0 || result.status === 'flaky_pass') {
    status = 'flaky_pass';
    failedStage = 'retry';
    failureClass = 'none';
  }

  const redactionManifest = {
    source: 'playwright-result-normalizer',
    consoleErrorCount: criticalConsole.length,
    failedNetworkCount: failedNetwork.length,
    missingArtifactTypes,
    invalidArtifactPaths: invalidArtifactPaths.map((entry) => redactPlaywrightText(entry, redactionValues)),
    retryCount,
    uncontrolledNetworkBlocked,
    deterministicSelectors,
    fixedTime,
    determinismRequired,
    determinismMissing,
  };

  const browserResult = buildBrowserCompletionResult({
    runId,
    goalId,
    scenarioId,
    status,
    failedStage,
    failureClass,
    evidenceDepth: depth,
    sourceFingerprint: result.sourceFingerprint || '',
    commands,
    artifacts,
    setupGap: status === 'setup_gap',
    artifactSha256: result.artifactSha256 || '',
    generatedAt,
    producerCommand: 'node scripts/verification-plane.mjs normalize-playwright-result',
    staleStatus: result.staleStatus || 'fresh',
    runtimeDecisionRef: result.runtimeDecisionRef || '',
    redactionManifest,
    taskVerificationClass,
  });

  return {
    schemaVersion: VERIFICATION_PLANE_SCHEMA_VERSION,
    status: 'normalized',
    browserResult,
    diagnostics: {
      missingArtifactTypes,
      invalidArtifactPaths: invalidArtifactPaths.map((entry) => redactPlaywrightText(entry, redactionValues)),
      criticalConsoleCount: criticalConsole.length,
      failedNetworkCount: failedNetwork.length,
      assertionFailureCount: assertionFailures.length,
      criticalConsoleSamples: criticalConsole.slice(0, 3).map((entry) => ({
        level: entry.level,
        critical: entry.critical,
      })),
      failedNetworkSamples: failedNetwork.slice(0, 3).map((entry) => ({
        status: entry.status,
        method: entry.method,
        failed: entry.failed,
      })),
      retryCount,
    },
  };
}

const hasRecordedPlaywrightExemption = (scenario = {}, taskVerificationClass = null) => {
  if (scenario.playwrightRequired !== false) {
    return false;
  }
  const taskClass = classifyTaskVerification(taskVerificationClass || scenario.taskVerificationClass || {});
  if (taskClass.criticalScenario) {
    return false;
  }
  const reason = String(scenario.playwrightNotRequiredReason || scenario.playwrightWaiver?.reason || '').trim();
  const approvedBy = String(scenario.playwrightNotRequiredBy || scenario.playwrightWaiver?.approvedBy || '').trim();
  return Boolean(reason && approvedBy);
};

const normalizeUpstreamPlaywrightResult = ({
  repoRoot,
  runId,
  goalId,
  scenarioId,
  scenario,
  playwrightResult,
  taskVerificationClass,
  generatedAt,
}) => {
  if (playwrightResult?.browserResult) {
    return playwrightResult;
  }
  if (playwrightResult && Object.keys(playwrightResult).length > 0) {
    return normalizePlaywrightResult({
      repoRoot,
      runId,
      goalId,
      scenarioId,
      scenario,
      result: playwrightResult,
      taskVerificationClass,
      generatedAt,
    });
  }
  return null;
};

const confirmationArtifactEntries = (confirmation = {}) => {
  const entries = Array.isArray(confirmation.artifacts) ? [...confirmation.artifacts] : [];
  if (confirmation.screenshotPath) {
    entries.push({ type: 'screenshot', path: confirmation.screenshotPath });
  }
  if (confirmation.snapshotPath) {
    entries.push({ type: 'accessibility_snapshot', path: confirmation.snapshotPath });
  }
  return entries;
};

export function normalizeBrowserConfirmationResult({
  repoRoot = process.cwd(),
  runId,
  goalId,
  scenarioId,
  scenario = {},
  confirmation = {},
  playwrightResult = null,
  taskVerificationClass = null,
  generatedAt = nowIso(),
} = {}) {
  const redactionValues = collectRedactionValues(scenario, confirmation, playwrightResult);
  const backend = String(confirmation.backend || confirmation.adapter || scenario.browserConfirmation?.backend || 'agent-browser').trim();
  const backendSupported = SUPPORTED_BROWSER_CONFIRMATION_BACKENDS.includes(backend);
  const normalizedPlaywright = normalizeUpstreamPlaywrightResult({
    repoRoot,
    runId,
    goalId,
    scenarioId,
    scenario,
    playwrightResult,
    taskVerificationClass,
    generatedAt,
  });
  const playwrightExempt = hasRecordedPlaywrightExemption(scenario, taskVerificationClass);
  const playwrightBrowserResult = normalizedPlaywright?.browserResult || null;
  const playwrightPassed = playwrightBrowserResult
    ? playwrightBrowserResult.status === 'clean_pass'
      && playwrightBrowserResult.setupGap === false
      && playwrightBrowserResult.failureClass === 'none'
    : false;
  const playwrightGatePassed = playwrightPassed || playwrightExempt;

  const expectedUrl = String(scenario.expectedUrl || '').trim();
  const expectedText = String(scenario.expectedText || '').trim();
  const expectedRole = String(scenario.expectedRole || '').trim();
  const expectedName = String(scenario.expectedName || '').trim();
  const actualUrl = String(confirmation.url || '').trim();
  const artifacts = confirmationArtifactEntries(confirmation).map((artifact) => normalizeArtifactEntry(artifact, repoRoot, redactionValues));
  const screenshotArtifacts = artifacts.filter((artifact) => artifact.type === 'screenshot');
  const screenshotPresent = screenshotArtifacts.some((artifact) => artifact.exists && artifact.pathAllowed);
  const structuredSnapshotPresent = Boolean(
    confirmation.accessibilitySnapshot
      || confirmation.pageSnapshot
      || artifacts.some((artifact) => artifact.type === 'accessibility_snapshot' && artifact.exists && artifact.pathAllowed),
  );
  const invalidArtifactPaths = artifacts.filter((artifact) => artifact.path && !artifact.pathAllowed).map((artifact) => artifact.path);
  const consoleErrorCount = Number(confirmation.consoleSummary?.errorCount || confirmation.consoleErrorCount || 0);
  const failedNetworkCount = Number(
    confirmation.networkSummary?.failedRequestCount
      ?? confirmation.networkSummary?.failedCount
      ?? confirmation.failedNetworkCount
      ?? 0,
  );
  const backendUnavailable = confirmation.status === 'setup_gap'
    || confirmation.backendAvailable === false
    || confirmation.failureClass === 'missing_browser_backend'
    || confirmation.failureClass === 'browser_backend_unavailable'
    || confirmation.errorCode === 'ENOENT';
  const tamperedAssertions = Boolean(
    confirmation.updatedExpectedText
      || confirmation.expectedTextChanged
      || confirmation.assertionsDeleted
      || (Array.isArray(confirmation.mutations) && confirmation.mutations.some((entry) => /expected|assert/i.test(String(entry)))),
  );
  const authorityContaminated = Boolean(
    (Object.hasOwn(confirmation, 'completionAuthority') && confirmation.completionAuthority !== false)
      || (confirmation.authoritySource && confirmation.authoritySource !== 'evidence_only'),
  );
  const urlMatches = expectedUrl ? actualUrl === expectedUrl : Boolean(actualUrl);
  const expectedTextFound = Boolean(expectedText && confirmation.expectedTextFound === true);
  const roleNameFound = Boolean(expectedRole && expectedName && (confirmation.roleNameFound === true || confirmation.affordanceFound === true));
  const missingChecks = [
    expectedUrl && !urlMatches ? 'url' : '',
    !expectedTextFound ? 'expected_text' : '',
    !roleNameFound ? 'role_name_affordance' : '',
    !structuredSnapshotPresent ? 'accessibility_snapshot' : '',
    !screenshotPresent ? 'screenshot' : '',
  ].filter(Boolean);

  let status = 'clean_pass';
  let failedStage = '';
  let failureClass = 'none';

  if (!playwrightGatePassed) {
    status = playwrightBrowserResult?.status === 'setup_gap'
      ? 'setup_gap'
      : playwrightBrowserResult?.status === 'flaky_pass' ? 'flaky_pass' : 'failed';
    failedStage = 'playwright';
    failureClass = playwrightBrowserResult?.failureClass && playwrightBrowserResult.failureClass !== 'none'
      ? playwrightBrowserResult.failureClass
      : 'playwright_assertion_failed';
  } else if (!backendSupported) {
    status = 'setup_gap';
    failedStage = 'browser_backend';
    failureClass = 'setup_gap';
  } else if (backendUnavailable) {
    status = 'setup_gap';
    failedStage = 'browser_backend';
    failureClass = 'runtime_environment_failed';
  } else if (authorityContaminated) {
    status = 'failed';
    failedStage = 'authority_contract';
    failureClass = 'browser_confirmation_failed';
  } else if (tamperedAssertions) {
    status = 'failed';
    failedStage = 'assertion_contract';
    failureClass = 'browser_confirmation_failed';
  } else if (invalidArtifactPaths.length > 0 || missingChecks.length > 0) {
    status = 'failed';
    failedStage = invalidArtifactPaths.length > 0 || missingChecks.includes('screenshot') ? 'artifact' : 'confirmation';
    failureClass = invalidArtifactPaths.length > 0 || missingChecks.includes('screenshot') ? 'artifact_missing' : 'browser_confirmation_failed';
  } else if (consoleErrorCount > 0 || failedNetworkCount > 0 || confirmation.status === 'failed') {
    status = 'failed';
    failedStage = consoleErrorCount > 0 ? 'console' : failedNetworkCount > 0 ? 'network' : 'confirmation';
    failureClass = 'browser_confirmation_failed';
  }

  const commands = [
    ...(Array.isArray(confirmation.commands) ? confirmation.commands : []),
    {
      command: confirmation.command || `${backend} confirm`,
      stdout: confirmation.stdout || '',
      stderr: confirmation.stderr || '',
      exitCode: Number.isFinite(Number(confirmation.exitCode)) ? Number(confirmation.exitCode) : null,
    },
  ].filter((command) => command.command || command.stdout || command.stderr);

  const redactionManifest = {
    source: 'agentic-browser-confirmation-normalizer',
    backend,
    backendSupported,
    playwrightGatePassed,
    playwrightExempt,
    expectedUrl,
    expectedText,
    expectedRole,
    expectedName,
    actualUrl,
    urlMatches,
    expectedTextFound,
    roleNameFound,
    structuredSnapshotPresent,
    screenshotPresent,
    missingChecks,
    consoleErrorCount,
    failedNetworkCount,
    authorityContaminated,
    invalidArtifactPaths,
  };

  const browserResult = buildBrowserCompletionResult({
    runId,
    goalId,
    scenarioId,
    status,
    failedStage,
    failureClass,
    evidenceDepth: 'agentic-browser-confirmation',
    sourceFingerprint: confirmation.sourceFingerprint || '',
    commands,
    artifacts,
    setupGap: status === 'setup_gap',
    artifactSha256: confirmation.artifactSha256 || '',
    generatedAt,
    producerCommand: 'node scripts/verification-plane.mjs normalize-browser-confirmation',
    staleStatus: confirmation.staleStatus || 'fresh',
    runtimeDecisionRef: confirmation.runtimeDecisionRef || '',
    redactionManifest,
    taskVerificationClass,
  });

  return {
    schemaVersion: VERIFICATION_PLANE_SCHEMA_VERSION,
    status: 'normalized',
    browserResult,
    diagnostics: {
      backend,
      backendSupported,
      playwrightGatePassed,
      playwrightExempt,
      playwrightStatus: playwrightBrowserResult?.status || 'missing',
      missingChecks,
      invalidArtifactPaths: invalidArtifactPaths.map((entry) => redactPlaywrightText(entry, redactionValues)),
      consoleErrorCount,
      failedNetworkCount,
      tamperedAssertions,
      authorityContaminated,
    },
  };
}

export function browserResultToPlane(result = {}, taskVerificationClass = null) {
  const taskClass = taskVerificationClass
    ? classifyTaskVerification(taskVerificationClass)
    : (result.taskVerificationClass || null);
  const requiresBrowserEvidence = taskClass?.requiresBrowserEvidence !== false;
  if (!result || Object.keys(result).length === 0) {
    return {
      plane: 'browser',
      status: requiresBrowserEvidence ? 'missing' : 'passed',
      evidenceDepth: 'none',
      reason: requiresBrowserEvidence ? 'missing browser completion result' : 'browser evidence not required',
    };
  }
  if (result.completionAuthority !== false || result.authoritySource !== 'evidence_only') {
    return {
      plane: 'browser',
      status: 'blocked',
      evidenceDepth: result.evidenceDepth || '',
      reason: 'browser result must be evidence_only and completionAuthority=false',
    };
  }
  if (result.staleStatus && result.staleStatus !== 'fresh') {
    return {
      plane: 'browser',
      status: 'stale',
      tracePath: result.artifacts?.[0]?.path || '',
      evidenceDepth: result.evidenceDepth || '',
      reason: `browser result is ${result.staleStatus}`,
    };
  }
  if (result.setupGap || result.status === 'setup_gap') {
    return {
      plane: 'browser',
      status: 'blocked',
      tracePath: result.artifacts?.[0]?.path || '',
      evidenceDepth: result.evidenceDepth || '',
      reason: 'browser result is setup_gap',
    };
  }
  if (result.status === 'flaky_pass' && taskClass?.criticalScenario) {
    return {
      plane: 'browser',
      status: 'blocked',
      tracePath: result.artifacts?.[0]?.path || '',
      evidenceDepth: result.evidenceDepth || '',
      reason: 'flaky_pass is not clean finish evidence for critical scenarios',
    };
  }
  if (result.criticalSmokeOnlyWarning) {
    return {
      plane: 'browser',
      status: 'blocked',
      tracePath: result.artifacts?.[0]?.path || '',
      evidenceDepth: result.evidenceDepth || '',
      reason: 'smoke-only browser evidence cannot cleanly close a critical scenario',
    };
  }
  return {
    plane: 'browser',
    status: result.status === 'clean_pass' ? 'passed' : 'failed',
    tracePath: result.artifacts?.[0]?.path || '',
    evidenceDepth: result.evidenceDepth || '',
    reason: result.status === 'clean_pass' ? 'browser completion result passed' : (result.failureClass || 'browser result failed'),
  };
}

export function evidenceIdFor(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function normalizePlaneList(planes = []) {
  return planes.map((entry) => ({
    ...entry,
    plane: String(entry.plane || '').trim(),
    status: String(entry.status || '').trim(),
  }));
}

const DEFAULT_ENV_ALLOWLIST = ['NODE_ENV', 'CI', 'OS', 'PROCESSOR_ARCHITECTURE'];

export function buildCommandEvidence({
  argv = [],
  cwd = '.',
  env = {},
  envAllowlist = DEFAULT_ENV_ALLOWLIST,
  timeoutMs = 0,
  exitCode = null,
  stdout = '',
  stderr = '',
  startedAt = nowIso(),
  endedAt = nowIso(),
} = {}) {
  const allowedEnv = {};
  for (const key of envAllowlist) {
    if (Object.hasOwn(env, key)) allowedEnv[key] = String(env[key]);
  }
  return {
    argv: argv.map(String),
    cwd,
    env: allowedEnv,
    timeoutMs: Number(timeoutMs),
    exitCode,
    startedAt,
    endedAt,
    stdoutDigest: sha256Hex(stdout),
    stderrDigest: sha256Hex(stderr),
  };
}

export function buildVerificationReceipt({
  candidate,
  sourceDigest,
  environmentDigest,
  policyDigest = '',
  commands = [],
  status = 'passed',
} = {}) {
  const candidate_id = normalizeCandidateId(candidate);
  return {
    schemaVersion: 1,
    artifactId: 'VERIFICATION_RECEIPT',
    candidate_id,
    candidateId: candidate_id,
    sourceDigest: sourceDigest || candidate?.dimensions?.source || '',
    environmentDigest: environmentDigest || candidate?.dimensions?.environment || '',
    policyDigest: policyDigest || candidate?.dimensions?.policy || '',
    status,
    commands,
  };
}

export function scoreCandidate({
  candidate,
  verification,
  reviewFindings = [],
  policyVersion = 'score-policy-v1',
  hardGates = [],
  memoryGates = [],
  weights = {},
} = {}) {
  const candidate_id = normalizeCandidateId(candidate || verification);
  const normalizedMemoryGates = memoryGates.map((gate) => {
    const metricFailure = Number(gate.staleMemoryErrorCount || 0) > 0
      || Number(gate.unauthorizedMemoryAccess || 0) > 0
      || Number(gate.candidateAsFactViolations || 0) > 0
      || Number(gate.piiPolicyViolations || 0) > 0
      || (Number.isFinite(Number(gate.provenanceCoverage)) && Number(gate.provenanceCoverage) < 1)
      || (Array.isArray(gate.findings) && gate.findings.length > 0);
    if (gate.status === 'passed' && metricFailure) {
      return {
        ...gate,
        status: 'failed',
        findings: [
          ...(Array.isArray(gate.findings) ? gate.findings : []),
          'memory gate metrics are inconsistent with passed status',
        ],
      };
    }
    return gate;
  });
  const binding = evidenceBinding({
    candidate_id,
    sourceDigest: verification?.sourceDigest || candidate?.dimensions?.source,
    environmentDigest: verification?.environmentDigest || candidate?.dimensions?.environment,
    policyDigest: verification?.policyDigest || candidate?.dimensions?.policy,
  });
  const classifiedFindings = reviewFindings.map((finding) => classifyFinding(finding));
  const failedHardGates = hardGates.filter((gate) => gate.status !== 'passed');
  const failedMemoryGates = normalizedMemoryGates.filter((gate) => gate.status !== 'passed');
  const blockingFindings = classifiedFindings.filter((finding) => finding.blocksFullScore);
  const verificationFailed = verification?.status !== 'passed';
  const hardGateFailed = failedHardGates.length > 0 || failedMemoryGates.length > 0 || blockingFindings.length > 0 || verificationFailed;
  const provenanceValues = normalizedMemoryGates
    .map((gate) => Number(gate.provenanceCoverage))
    .filter((value) => Number.isFinite(value));
  const provenanceCoverage = provenanceValues.length
    ? provenanceValues.reduce((sum, value) => sum + value, 0) / provenanceValues.length
    : 1;
  const weightedScore = hardGateFailed
    ? 0
    : Math.min(1, Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0) || 1);
  return {
    schemaVersion: 1,
    artifactId: 'SCORE_RECEIPT',
    candidate_id,
    candidateId: candidate_id,
    sourceDigest: binding.sourceDigest,
    environmentDigest: binding.environmentDigest,
    policyDigest: binding.policyDigest,
    policyVersion,
    status: hardGateFailed ? 'BLOCKED' : 'FULL',
    hardGates: [
      ...hardGates,
      ...failedMemoryGates.map((gate, index) => ({
        id: gate.id || `memory-gate-${index + 1}`,
        status: 'failed',
        reason: `memory gate failed: ${gate.findings?.join('; ') || gate.status}`,
      })),
      ...blockingFindings.map((finding) => ({
        id: finding.findingId,
        status: 'failed',
        reason: `review finding blocks FULL: ${finding.summary || finding.findingId}`,
      })),
      ...(verificationFailed ? [{ id: 'verification-status', status: 'failed', reason: `verification status ${verification?.status || 'missing'}` }] : []),
    ],
    memoryQuality: {
      gateCount: normalizedMemoryGates.length,
      failedGateCount: failedMemoryGates.length,
      provenanceCoverage,
      staleMemoryErrorCount: normalizedMemoryGates.reduce((sum, gate) => sum + Number(gate.staleMemoryErrorCount || 0), 0),
      unauthorizedMemoryAccess: normalizedMemoryGates.reduce((sum, gate) => sum + Number(gate.unauthorizedMemoryAccess || 0), 0),
      candidateAsFactViolations: normalizedMemoryGates.reduce((sum, gate) => sum + Number(gate.candidateAsFactViolations || 0), 0),
      piiPolicyViolations: normalizedMemoryGates.reduce((sum, gate) => sum + Number(gate.piiPolicyViolations || 0), 0),
    },
    weightedScore,
    wholePlanAuthority: {
      status: 'not_completion_authority',
      acceptedCompletionRequired: true,
      authoritySource: 'runtime-state.sqlite',
    },
  };
}

export function projectVerifyScoreEvidence({ runId, goalId, verifyReceipt, scoreReceipt } = {}) {
  return {
    runtimeEvent: {
      event_type: 'verification.score',
      severity: scoreReceipt?.status === 'FULL' ? 'info' : 'blocking',
      payload: {
        candidate_id: scoreReceipt?.candidate_id || verifyReceipt?.candidate_id || '',
        verifyStatus: verifyReceipt?.status || '',
        scoreStatus: scoreReceipt?.status || '',
        policyVersion: scoreReceipt?.policyVersion || '',
      },
    },
    evalEvidence: {
      runId,
      goalId,
      suite: 'verification-scoring',
      status: scoreReceipt?.status === 'FULL' ? 'passed' : 'failed',
      evidence: {
        verifyReceipt,
        scoreReceipt,
      },
    },
  };
}

export function buildVerificationSummary({
  runId,
  goalId,
  planes = [],
  profile = 'runtime_adapter',
  requiredPlanes = null,
  taskVerificationClass = null,
  browserCompletionResult = null,
  specTestObligations = null,
  reviewCritiqueLoopReceipt = null,
  repairLoopReceipt = null,
  completionClaim = false,
  phaseCloseout = false,
  identity = {},
  producedAt = nowIso(),
  maxAgeMinutes = 60,
  reason = 'verification plane evidence accepted',
} = {}) {
  if (!Object.hasOwn(VERIFICATION_PROFILES, profile)) {
    throw new Error(`unknown verification profile: ${profile}`);
  }
  const taskClass = classifyTaskVerification(taskVerificationClass || {});
  const browserPlane = browserCompletionResult ? browserResultToPlane(browserCompletionResult, taskClass) : null;
  const inputPlanes = browserPlane
    ? [...planes.filter((plane) => plane?.plane !== 'browser'), browserPlane]
    : planes;
  const normalizedPlanes = normalizePlaneList(inputPlanes);
  const planeByName = new Map(normalizedPlanes.map((plane) => [plane.plane, plane]));
  const profileRequiredPlanes = Array.isArray(requiredPlanes) ? requiredPlanes : VERIFICATION_PROFILES[profile];
  const completionAuthorityRequiredPlanes = COMPLETION_AUTHORITY_REQUIRED_PLANES;
  const missingPlanes = profileRequiredPlanes.filter((plane) => !planeByName.has(plane));
  const failedPlanes = normalizedPlanes
    .filter((plane) => profileRequiredPlanes.includes(plane.plane))
    .filter((plane) => plane.status !== 'passed')
    .map((plane) => ({ plane: plane.plane, status: plane.status || 'missing' }));
  const missingCompletionAuthorityPlanes = completionAuthorityRequiredPlanes.filter((plane) => !planeByName.has(plane));
  const producedDate = parseDate(producedAt);
  const maxAgeMs = Number(maxAgeMinutes) * 60 * 1000;
  const ageMs = producedDate ? Date.now() - producedDate.getTime() : Number.POSITIVE_INFINITY;
  const stale = !producedDate || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || ageMs > maxAgeMs;
  const staleReason = stale ? `stale verification evidence: producedAt=${producedAt}` : '';
  const securityPlane = planeByName.get('security') || {};
  const securityBlockers = Array.isArray(securityPlane.blockers) ? securityPlane.blockers : [];
  const profileChecksPassed = missingPlanes.length === 0
    && failedPlanes.length === 0
    && securityBlockers.length === 0
    && !stale;
  const completionAuthorityFailedPlanes = normalizedPlanes
    .filter((plane) => completionAuthorityRequiredPlanes.includes(plane.plane))
    .filter((plane) => plane.status !== 'passed')
    .map((plane) => ({ plane: plane.plane, status: plane.status || 'missing' }));
  const wholePlanAuthorityEligible = missingCompletionAuthorityPlanes.length === 0
    && completionAuthorityFailedPlanes.length === 0
    && securityBlockers.length === 0
    && !stale;
  const taskEvidenceBlockers = [];
  if (taskClass?.status === 'needs_classification') {
    taskEvidenceBlockers.push({ code: 'needs_classification', reason: taskClass.reason });
  }
  if (taskClass?.waiver?.allowed && (!taskClass.waiver.reason || !taskClass.waiver.approvedBy)) {
    taskEvidenceBlockers.push({ code: 'waiver_incomplete', reason: 'waiver is incomplete' });
  }
  if (taskClass?.requiresBrowserEvidence) {
    const currentBrowserPlane = planeByName.get('browser');
    if (!browserCompletionResult) {
      taskEvidenceBlockers.push({ code: 'browser_evidence_missing', reason: 'missing browser completion result for browser-required task' });
    } else if (!currentBrowserPlane) {
      taskEvidenceBlockers.push({ code: 'browser_evidence_missing', reason: 'missing browser evidence for browser-required task' });
    } else if (currentBrowserPlane.status !== 'passed') {
      taskEvidenceBlockers.push({ code: 'browser_evidence_blocked', reason: currentBrowserPlane.reason || `browser evidence ${currentBrowserPlane.status}` });
    }
  }
  if (taskClass?.requiresIntegrationEvidence && !planeByName.has('package')) {
    taskEvidenceBlockers.push({ code: 'integration_evidence_missing', reason: 'missing package/integration evidence for integration-required task' });
  }
  const specTestResultRequired = toBool(completionClaim)
    || toBool(phaseCloseout)
    || identity?.completionClaim === true
    || identity?.phaseCloseout === true
    || identity?.closeoutIntent === true;
  if (specTestResultRequired && !specTestObligations) {
    taskEvidenceBlockers.push({
      code: 'spec_test_obligation_result_missing',
      reason: 'spec-test obligation validator result is required for completion claim or phase closeout',
    });
  }
  if (specTestObligations?.status === 'fail') {
    const findings = Array.isArray(specTestObligations.findings) ? specTestObligations.findings : [];
    for (const entry of findings.filter((finding) => finding?.severity !== 'warning')) {
      taskEvidenceBlockers.push({
        code: entry.class || 'spec_test_obligation_failed',
        reason: `${entry.id || 'spec'}: ${entry.message || entry.class || 'spec-test obligation failed'}`,
      });
    }
    if (findings.length === 0) {
      taskEvidenceBlockers.push({
        code: 'spec_test_obligation_failed',
        reason: 'spec-test obligations failed',
      });
    }
  }
  const normalizedReviewReceipt = reviewCritiqueLoopReceipt
    ? normalizeReviewCritiqueLoopReceipt(reviewCritiqueLoopReceipt)
    : null;
  const reviewRequired = toBool(completionClaim)
    || toBool(phaseCloseout)
    || identity?.completionClaim === true
    || identity?.phaseCloseout === true
    || identity?.closeoutIntent === true
    || taskClass?.requiresBrowserEvidence
    || taskClass?.requiresIntegrationEvidence
    || taskClass?.criticalScenario
    || taskClass?.status === 'needs_classification';
  const reviewBlockers = reviewCritiqueLoopBlockers({
    receipt: reviewCritiqueLoopReceipt,
    required: reviewRequired,
    candidate_id: identity?.candidate_id || identity?.candidateId || '',
    sourceDigest: identity?.sourceDigest || '',
    bundleDigest: identity?.bundleDigest || '',
  });
  taskEvidenceBlockers.push(...reviewBlockers);
  const repairRequired = browserCompletionResult
    && browserCompletionResult.status !== 'clean_pass'
    && browserCompletionResult.status !== 'flaky_pass';
  taskEvidenceBlockers.push(...repairLoopBlockers({
    receipt: repairLoopReceipt,
    required: repairRequired,
  }));
  const taskLocalBlocker = firstReason(
    taskEvidenceBlockers[0]?.reason,
    staleReason,
    securityBlockers[0]?.reason,
    failedPlanes[0] ? `failed verification plane: ${failedPlanes[0].plane}` : '',
    missingPlanes[0] ? `missing verification plane: ${missingPlanes[0]}` : '',
  );
  const wholePlanBlocker = firstReason(
    staleReason,
    securityBlockers[0]?.reason,
    completionAuthorityFailedPlanes[0] ? `failed verification plane: ${completionAuthorityFailedPlanes[0].plane}` : '',
    missingCompletionAuthorityPlanes[0] ? `missing verification plane: ${missingCompletionAuthorityPlanes[0]}` : '',
  );
  const requiredChecksPassed = profileChecksPassed && taskEvidenceBlockers.length === 0;

  return {
    schemaVersion: VERIFICATION_PLANE_SCHEMA_VERSION,
    runId,
    goalId,
    fresh: !stale,
    stale,
    staleReason,
    requiredChecksPassed,
    activeIdentityPresent: true,
    identityMatches: true,
    identity,
    reason,
    producedAt,
    maxAgeMinutes: Number(maxAgeMinutes),
    profile,
    taskVerificationClass: taskClass,
    browserCompletionResult: browserCompletionResult || null,
    specTestObligations: specTestObligations || null,
    reviewCritiqueLoopReceipt: normalizedReviewReceipt,
    reviewCritiqueLoopRequired: Boolean(reviewRequired),
    repairLoopReceipt: repairLoopReceipt || null,
    repairLoopRequired: Boolean(repairRequired),
    taskEvidenceBlockers,
    profileRequiredPlanes,
    completionAuthorityRequiredPlanes,
    requiredPlanes: profileRequiredPlanes,
    planes: normalizedPlanes,
    missingPlanes,
    missingProfilePlanes: missingPlanes,
    missingCompletionAuthorityPlanes,
    failedPlanes,
    securityBlockers,
    taskLocalCompletion: {
      status: requiredChecksPassed ? 'complete' : 'blocked',
      fresh: !stale,
      profile,
      requiredPlanes: profileRequiredPlanes,
      missingPlanes,
      failedPlanes,
      reason: requiredChecksPassed ? 'profile evidence complete' : taskLocalBlocker,
    },
    wholePlanAuthority: {
      status: wholePlanAuthorityEligible ? 'evidence_eligible' : 'blocked',
      authoritySource: 'runtime-state.sqlite',
      acceptedCompletionRequired: true,
      requiredPlanes: completionAuthorityRequiredPlanes,
      missingPlanes: missingCompletionAuthorityPlanes,
      failedPlanes: completionAuthorityFailedPlanes,
      reason: wholePlanAuthorityEligible ? 'all authority planes present; accepted DB decision still required' : wholePlanBlocker,
    },
    evidenceId: evidenceIdFor({ runId, goalId, producedAt, profile, requiredPlanes: profileRequiredPlanes, planes: normalizedPlanes }),
  };
}

function scanIsStale(scan, maxAgeMinutes) {
  if (!scan.producedAt) {
    return false;
  }
  const producedDate = parseDate(scan.producedAt);
  if (!producedDate) {
    return true;
  }
  return Date.now() - producedDate.getTime() > Number(maxAgeMinutes) * 60 * 1000;
}

function normalizeFindingSeverity(finding) {
  return String(finding.severity || finding.level || finding.alertSeverity || '').trim().toLowerCase();
}

function exceptionIsApproved(exception) {
  return Boolean(exception?.approvalId && exception?.owner && exception?.reason);
}

export function assessSecurityScans({
  scans = {},
  maxAgeMinutes = 24 * 60,
  exception = null,
} = {}) {
  const blockers = [];

  for (const scanName of REQUIRED_SECURITY_SCANS) {
    const scan = scans[scanName];
    if (!scan || scan.status === 'missing') {
      blockers.push({ scan: scanName, reason: `missing scan: ${scanName}`, severity: 'blocking' });
      continue;
    }
    if (scan.status === 'stale' || scanIsStale(scan, maxAgeMinutes)) {
      blockers.push({ scan: scanName, reason: `stale scan: ${scanName}`, severity: 'blocking' });
    }
    if (scan.status === 'failed') {
      blockers.push({ scan: scanName, reason: `failed scan: ${scanName}`, severity: 'blocking' });
    }
    for (const finding of Array.isArray(scan.findings) ? scan.findings : []) {
      const severity = normalizeFindingSeverity(finding);
      if (BLOCKING_SEVERITIES.has(severity)) {
        blockers.push({
          scan: scanName,
          reason: `${severity} security finding: ${scanName}`,
          severity,
          finding,
        });
      }
    }
  }

  const exceptionApplied = blockers.length > 0 && exceptionIsApproved(exception);
  const decoratedBlockers = exceptionApplied
    ? blockers.map((blocker) => ({ ...blocker, approvedException: exception }))
    : blockers;

  return {
    schemaVersion: VERIFICATION_PLANE_SCHEMA_VERSION,
    status: exceptionApplied || blockers.length === 0 ? 'passed' : 'blocked',
    releaseBlocked: blockers.length > 0 && !exceptionApplied,
    exceptionApplied,
    requiredScans: REQUIRED_SECURITY_SCANS,
    blockers: decoratedBlockers,
    scans,
    assessedAt: nowIso(),
  };
}

export async function writeBrowserTraceMetadata({
  repoRoot = process.cwd(),
  runId,
  goalId,
  flow = 'smoke',
  url = '',
  runtime = 'browserctl',
  evidenceDepth = 'smoke',
} = {}) {
  const safeFlow = String(flow || 'smoke').replace(/[^a-zA-Z0-9._-]/g, '-');
  const tracePath = path.join(
    '.moonshot-relay',
    'browser-artifacts',
    runId,
    goalId,
    safeFlow,
    'trace-metadata.json',
  ).replaceAll(path.sep, '/');
  const absolutePath = path.join(repoRoot, tracePath);
  const metadata = {
    schemaVersion: VERIFICATION_PLANE_SCHEMA_VERSION,
    traceId: evidenceIdFor({ runId, goalId, flow: safeFlow, url }),
    runId,
    goalId,
    flow: safeFlow,
    url,
    runtime,
    evidenceDepth,
    reproducible: true,
    generatedStateRoot: '.moonshot-relay/browser-artifacts',
    createdAt: nowIso(),
  };

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  return {
    status: 'recorded',
    traceId: metadata.traceId,
    tracePath,
    metadata,
  };
}
