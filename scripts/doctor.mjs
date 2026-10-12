#!/usr/bin/env node
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  assertRuntimeSurfaceUnexpanded,
  auditSkillsLock,
} from './kernel/standalone/skills-lock.js';
import { resolveRuntimeNode } from './lib/moonshot-runtime-resolver.mjs';

const usage = () => 'Usage: node scripts/doctor.mjs check [--repo-root <root>] [--evidence-root <root>] [--lock <skills-lock.json>] [--runtime-surface <runtime-surface.json>] [--expected-runtime-surface-json <json-array>] [--json]';

const parseArgs = (argv) => {
  const options = { command: argv[0] || '', json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') options.repoRoot = argv[++index] || '';
    else if (arg === '--evidence-root') options.evidenceRoot = argv[++index] || '';
    else if (arg === '--lock') options.lock = argv[++index] || '';
    else if (arg === '--runtime-surface') options.runtimeSurface = argv[++index] || '';
    else if (arg === '--expected-runtime-surface-json') options.expectedRuntimeSurfaceJson = argv[++index] || '';
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
};

const resolveFromRoot = (repoRoot, file) => (path.isAbsolute(file) ? file : path.join(repoRoot, file));

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const tryReadJson = async (file) => {
  try {
    return { ok: true, value: await readJson(file) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const pathExists = async (file) => {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizePath = (value = '') => String(value).replaceAll('\\', '/');

const relativePath = (repoRoot, file) => normalizePath(path.relative(repoRoot, file) || '.');

const findFilesByName = async (root, names, { maxDepth = 6 } = {}) => {
  if (!(await pathExists(root))) return [];
  const wanted = new Set(names);
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        const fileStat = await stat(fullPath);
        found.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
      }
    }
  };
  await walk(root, 0);
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const latestJsonByName = async (root, name) => {
  const [latest] = await findFilesByName(root, [name]);
  if (!latest) return null;
  const parsed = await tryReadJson(latest.path);
  return { ...latest, ...parsed };
};

const latestHarnessLabResult = async (evidenceRoot) => latestJsonByName(
  path.join(evidenceRoot, '.moonshot-relay', 'harness-lab-runs'),
  'lab-result.json',
);

const modernLabSuiteEvidence = async ({ evidenceRoot, suiteId }) => {
  const labResult = await latestHarnessLabResult(evidenceRoot);
  if (!labResult) return null;
  if (!labResult.ok) return { labResult, suite: null, artifact: null, artifactPath: null };
  const suite = (labResult.value?.candidate?.results || []).find((entry) => entry.id === suiteId) || null;
  const runRoot = path.dirname(labResult.path);
  const declaredPath = suite?.stdout?.path;
  const artifactPath = declaredPath ? path.resolve(runRoot, declaredPath) : null;
  const safelyBound = artifactPath === runRoot || artifactPath?.startsWith(`${runRoot}${path.sep}`);
  const artifact = safelyBound && artifactPath ? await tryReadJson(artifactPath) : null;
  return { labResult, suite, artifact, artifactPath: safelyBound ? artifactPath : null };
};

const ageDays = (timestamp) => {
  const time = Date.parse(timestamp || '');
  if (Number.isNaN(time)) return null;
  return Math.floor((Date.now() - time) / 86_400_000);
};

const isStale = (timestamp, maxAgeDays = 30) => {
  const days = ageDays(timestamp);
  return days !== null && days > maxAgeDays;
};

const summarizeRuntimeSurface = ({ repoRoot, runtimeSurface, runtimeSurfacePath, expectedRuntimeSurface, findings }) => {
  const added = (runtimeSurface.publicRuntimeSkills || []).filter(
    (skill) => !(expectedRuntimeSurface || []).includes(skill),
  );
  return {
    status: findings.some((finding) => finding.type === 'runtime_surface_expanded') ? 'blocked' : 'pass',
    path: relativePath(repoRoot, runtimeSurfacePath),
    schemaVersion: runtimeSurface.schemaVersion,
    publicRuntimeSkillCount: (runtimeSurface.publicRuntimeSkills || []).length,
    expansionGuard: added.length > 0 ? 'blocked' : 'unchanged',
    addedSkills: added,
  };
};

const summarizeSkillsLock = ({ repoRoot, lockPath, lock, skills }) => ({
  status: skills.status,
  path: relativePath(repoRoot, lockPath),
  schemaVersion: lock?.schemaVersion ?? null,
  skillCount: Array.isArray(lock?.skills) ? lock.skills.length : 0,
  findingCount: skills.findings.length,
});

const summarizeLabReadiness = async ({ evidenceRoot, findings }) => {
  const modern = await latestHarnessLabResult(evidenceRoot);
  if (modern) {
    if (!modern.ok) {
      findings.push({
        type: 'lab_readiness_unreadable',
        severity: 'degraded',
        check: 'labReadiness',
        reason: modern.error,
      });
      return {
        status: 'degraded',
        evidenceSource: 'harness-lab-runs',
        latestResultPath: relativePath(evidenceRoot, modern.path),
      };
    }

    const result = modern.value;
    const timestamp = result.createdAt || (modern.mtimeMs ? new Date(modern.mtimeMs).toISOString() : null);
    const stale = isStale(timestamp);
    const requiredSuiteIds = ['harness-control-plane-eval', 'moonshot-research-fixture'];
    const candidateResults = Array.isArray(result.candidate?.results) ? result.candidate.results : [];
    const missingSuites = requiredSuiteIds.filter((id) => !candidateResults.some((entry) => entry.id === id));
    const failedSuites = candidateResults
      .filter((entry) => requiredSuiteIds.includes(entry.id) && entry.status !== 'passed')
      .map((entry) => entry.id);
    const failed = result.status !== 'passed' || result.candidate?.status !== 'passed' || failedSuites.length > 0;
    if (failed) {
      findings.push({
        type: 'lab_readiness_failed',
        severity: 'blocking',
        check: 'labReadiness',
        status: result.status ?? null,
        failedSuites,
      });
    } else if (stale) {
      findings.push({
        type: 'lab_readiness_stale',
        severity: 'degraded',
        check: 'labReadiness',
        ageDays: ageDays(timestamp),
      });
    } else if (missingSuites.length > 0) {
      findings.push({
        type: 'lab_readiness_partial',
        severity: 'degraded',
        check: 'labReadiness',
        reason: 'Latest harness lab result does not contain all required readiness suites.',
        missingSuites,
      });
    }

    return {
      status: failed ? 'degraded' : stale ? 'stale' : missingSuites.length > 0 ? 'degraded' : 'ready',
      evidenceSource: 'harness-lab-runs',
      latestResultPath: relativePath(evidenceRoot, modern.path),
      latestRunId: result.runId || result.run?.runId || null,
      latestEvidenceAt: timestamp,
      promotable: result.promotable === true,
      missingSuites,
      failedSuites,
    };
  }

  const labRoot = path.join(evidenceRoot, '.moonshot-relay', 'harness-lab');
  const baselinePath = path.join(labRoot, 'baselines', 'current.json');
  const baseline = await tryReadJson(baselinePath);
  const candidate = await latestJsonByName(path.join(labRoot, 'runs'), 'candidate-summary.json');
  const receipt = await latestJsonByName(path.join(labRoot, 'runs'), 'lab-closeout-receipt.json');

  if (!baseline.ok && !candidate && !receipt) {
    findings.push({
      type: 'lab_readiness_not_initialized',
      severity: 'degraded',
      check: 'labReadiness',
      reason: 'No baseline, candidate summary, or closeout receipt evidence was found.',
    });
    return {
      status: 'not_initialized',
      evidenceSource: 'legacy-harness-lab',
      baselinePointer: 'missing',
      latestCandidate: 'not_available',
      closeoutReceipt: 'not_available',
    };
  }

  const latestTimestamp = candidate?.value?.createdAt || receipt?.value?.createdAt || baseline.value?.updatedAt;
  const stale = isStale(latestTimestamp);
  const blockingGateCount = Array.isArray(receipt?.value?.blockingGates) ? receipt.value.blockingGates.length : 0;
  if (blockingGateCount > 0) {
    findings.push({
      type: 'lab_readiness_blocking_gate',
      severity: 'blocking',
      check: 'labReadiness',
      count: blockingGateCount,
    });
  } else if (stale) {
    findings.push({
      type: 'lab_readiness_stale',
      severity: 'degraded',
      check: 'labReadiness',
      ageDays: ageDays(latestTimestamp),
    });
  } else if (!baseline.ok || !candidate || !receipt) {
    findings.push({
      type: 'lab_readiness_partial',
      severity: 'degraded',
      check: 'labReadiness',
      reason: 'Lab evidence is present but incomplete.',
    });
  }

  return {
    status: blockingGateCount > 0 ? 'degraded' : stale ? 'stale' : !baseline.ok || !candidate || !receipt ? 'degraded' : 'ready',
    evidenceSource: 'legacy-harness-lab',
    baselineId: baseline.value?.baselineId ?? null,
    baselinePointer: baseline.ok ? relativePath(evidenceRoot, baselinePath) : 'missing',
    latestCandidateRunId: candidate?.value?.runId ?? null,
    latestCandidatePath: candidate ? relativePath(evidenceRoot, candidate.path) : null,
    closeoutReceiptPath: receipt ? relativePath(evidenceRoot, receipt.path) : null,
    blockingGateCount,
    latestEvidenceAt: latestTimestamp ?? null,
  };
};

const summarizeEvalReadiness = async ({ evidenceRoot, findings }) => {
  const modern = await modernLabSuiteEvidence({ evidenceRoot, suiteId: 'harness-control-plane-eval' });
  if (modern) {
    const timestamp = modern.labResult.ok
      ? modern.labResult.value.createdAt || new Date(modern.labResult.mtimeMs).toISOString()
      : null;
    const stale = isStale(timestamp);
    const artifact = modern.artifact?.value;
    const failedCount = Number(artifact?.failedCount ?? 0);
    const failed = modern.suite?.status !== 'passed' || artifact?.status !== 'passed' || failedCount > 0;
    if (!modern.labResult.ok || !modern.suite || !modern.artifact?.ok) {
      findings.push({
        type: 'eval_readiness_unreadable',
        severity: 'degraded',
        check: 'evalReadiness',
        reason: modern.labResult.error || modern.artifact?.error || 'Eval suite or its stdout artifact is missing.',
      });
      return {
        status: 'degraded',
        evidenceSource: 'harness-lab-runs',
        latestArtifact: modern.artifactPath ? relativePath(evidenceRoot, modern.artifactPath) : 'unavailable',
      };
    }
    if (failed) {
      findings.push({
        type: 'eval_readiness_failed',
        severity: 'blocking',
        check: 'evalReadiness',
        failedCount,
      });
    } else if (stale) {
      findings.push({
        type: 'eval_readiness_stale',
        severity: 'degraded',
        check: 'evalReadiness',
        ageDays: ageDays(timestamp),
      });
    }
    return {
      status: failed ? 'degraded' : stale ? 'stale' : 'ready',
      evidenceSource: 'harness-lab-runs',
      latestArtifact: relativePath(evidenceRoot, modern.artifactPath),
      latestEvidenceAt: timestamp,
      score: artifact.score ?? null,
      failedCount,
    };
  }

  const evalRoot = path.join(evidenceRoot, '.moonshot-relay', 'eval-artifacts');
  const labEvalStdout = (await findFilesByName(path.join(evidenceRoot, '.moonshot-relay', 'harness-lab', 'runs'), ['stdout.txt']))
    .find((entry) => normalizePath(entry.path).includes('/harness-control-plane-eval/stdout.txt'));
  const latest = labEvalStdout
    || await latestJsonByName(evalRoot, 'candidate.json')
    || (await findFilesByName(evalRoot, ['phase08-improvement-candidate.json']))[0];
  if (!latest) {
    findings.push({
      type: 'eval_readiness_not_available',
      severity: 'degraded',
      check: 'evalReadiness',
      reason: 'No eval artifact was found.',
    });
    return { status: 'not_available', latestArtifact: 'not_available' };
  }

  const parsed = latest.ok === undefined ? await tryReadJson(latest.path) : latest;
  if (!parsed.ok) {
    findings.push({
      type: 'eval_readiness_unreadable',
      severity: 'degraded',
      check: 'evalReadiness',
      reason: parsed.error,
    });
    return { status: 'degraded', latestArtifact: 'unreadable' };
  }

  const artifact = parsed.value;
  const timestamp = artifact.createdAt
    || artifact.finishedAt
    || artifact.observedAt
    || (latest.mtimeMs ? new Date(latest.mtimeMs).toISOString() : null);
  const stale = isStale(timestamp);
  const failedCount = Number(artifact.failedCount ?? artifact.score?.failedCount ?? 0);
  const score = artifact.score?.score ?? artifact.score ?? null;
  const scoreThreshold = artifact.scoreThreshold ?? artifact.score?.scoreThreshold ?? null;
  const scoreBelowThreshold = typeof score === 'number' && typeof scoreThreshold === 'number' && score < scoreThreshold;
  if (stale) {
    findings.push({
      type: 'eval_readiness_stale',
      severity: 'degraded',
      check: 'evalReadiness',
      ageDays: ageDays(timestamp),
    });
  }
  if (failedCount > 0 || artifact.status === 'failed') {
    findings.push({
      type: 'eval_readiness_failed',
      severity: 'blocking',
      check: 'evalReadiness',
      failedCount,
    });
  } else if (scoreBelowThreshold || artifact.lowScore || artifact.reviewStatus === 'pending_review') {
    findings.push({
      type: 'eval_readiness_review_required',
      severity: 'review',
      check: 'evalReadiness',
      score,
      scoreThreshold,
    });
  }

  return {
    status: failedCount > 0 || artifact.status === 'failed'
      ? 'degraded'
      : scoreBelowThreshold || artifact.lowScore || artifact.reviewStatus === 'pending_review'
        ? 'review_required'
        : stale
          ? 'stale'
          : 'ready',
    latestArtifact: 'available',
    latestEvidenceAt: timestamp ?? null,
    score,
    failedCount,
  };
};

const summarizeResearchReadiness = async ({ evidenceRoot, findings }) => {
  const modern = await modernLabSuiteEvidence({ evidenceRoot, suiteId: 'moonshot-research-fixture' });
  if (modern) {
    const timestamp = modern.labResult.ok
      ? modern.labResult.value.createdAt || new Date(modern.labResult.mtimeMs).toISOString()
      : null;
    const stale = isStale(timestamp);
    const artifact = modern.artifact?.value;
    const failureCount = Number(artifact?.laneFailureCount ?? 0);
    const failed = modern.suite?.status !== 'passed' || artifact?.status !== 'passed' || failureCount > 0;
    if (!modern.labResult.ok || !modern.suite || !modern.artifact?.ok) {
      findings.push({
        type: 'research_readiness_unreadable',
        severity: 'degraded',
        check: 'researchReadiness',
        reason: modern.labResult.error || modern.artifact?.error || 'Research fixture suite or its stdout artifact is missing.',
      });
      return {
        status: 'degraded',
        evidenceSource: 'harness-lab-runs',
        latestRunPath: modern.artifactPath ? relativePath(evidenceRoot, modern.artifactPath) : null,
      };
    }
    if (failed) {
      findings.push({
        type: 'research_fixture_failed',
        severity: 'blocking',
        check: 'researchReadiness',
        failureCount,
      });
    } else if (stale) {
      findings.push({
        type: 'research_readiness_stale',
        severity: 'degraded',
        check: 'researchReadiness',
        ageDays: ageDays(timestamp),
      });
    }
    return {
      status: failed ? 'degraded' : stale ? 'stale' : 'ready',
      evidenceSource: 'harness-lab-runs',
      latestRunPath: relativePath(evidenceRoot, modern.artifactPath),
      latestEvidenceAt: timestamp,
      fixtureSetId: artifact.fixtureSetId ?? null,
      evidenceCount: Number(artifact.evidenceCount ?? 0),
      queryCount: Number(artifact.queryVariantCount ?? 0),
      failureCount,
      claimLedgerCoverage: artifact.claimLedgerCoverage ?? null,
    };
  }

  const researchRoot = path.join(evidenceRoot, '.moonshot-relay', 'docs', 'research');
  const latestRun = await latestJsonByName(researchRoot, 'run.json');
  if (!latestRun) {
    findings.push({
      type: 'research_readiness_not_available',
      severity: 'degraded',
      check: 'researchReadiness',
      reason: 'No research run evidence was found.',
    });
    return { status: 'not_available', latestRunPath: null };
  }
  if (!latestRun.ok) {
    findings.push({
      type: 'research_readiness_unreadable',
      severity: 'degraded',
      check: 'researchReadiness',
      reason: latestRun.error,
    });
    return { status: 'degraded', latestRunPath: relativePath(evidenceRoot, latestRun.path) };
  }

  const runDir = path.dirname(latestRun.path);
  const evidence = await tryReadJson(path.join(runDir, 'evidence.json'));
  const claims = await tryReadJson(path.join(runDir, 'claim-ledger.json'));
  const evidenceItems = Array.isArray(evidence.value) ? evidence.value : [];
  const claimItems = Array.isArray(claims.value) ? claims.value : [];
  const accessBoundaryCount = evidenceItems.filter((item) => item.source_type === 'access boundary' || item.access_status === 'blocked or rate limited').length;
  const timestamp = latestRun.value.finished_at || latestRun.value.finishedAt || latestRun.value.started_at;
  const stale = isStale(timestamp);
  const failureCount = Array.isArray(latestRun.value.failures) ? latestRun.value.failures.length : 0;
  if (evidence.ok && evidenceItems.length === 0) {
    findings.push({
      type: 'research_empty_evidence_regression',
      severity: 'degraded',
      check: 'researchReadiness',
      reason: 'Research run evidence is present but empty.',
    });
  }
  if (failureCount > 0) {
    findings.push({
      type: 'research_collector_failures',
      severity: 'degraded',
      check: 'researchReadiness',
      count: failureCount,
    });
  }
  if (stale) {
    findings.push({
      type: 'research_readiness_stale',
      severity: 'degraded',
      check: 'researchReadiness',
      ageDays: ageDays(timestamp),
    });
  }

  return {
    status: failureCount > 0 || !evidence.ok || !claims.ok || evidenceItems.length === 0 ? 'degraded' : stale ? 'stale' : 'ready',
    latestRunPath: relativePath(evidenceRoot, latestRun.path),
    latestEvidenceAt: timestamp ?? null,
    lanes: latestRun.value.lanes || [],
    queryCount: Array.isArray(latestRun.value.queries) ? latestRun.value.queries.length : 0,
    failureCount,
    evidenceCount: evidenceItems.length,
    claimCount: claimItems.length,
    accessBoundaryCount,
    collectorCapabilities: latestRun.value.capabilities || {},
  };
};

const summarizeProfileTrust = ({ args, repoRoot, lockPath, runtimeSurfacePath }) => ({
  status: 'pass',
  mode: args.repoRoot ? 'explicit_repo_root' : 'source_checkout',
  repoRoot,
  lockPath: relativePath(repoRoot, lockPath),
  runtimeSurfacePath: relativePath(repoRoot, runtimeSurfacePath),
  installedInputs: Boolean(args.repoRoot && args.lock && args.runtimeSurface) ? 'explicit' : 'not_requested',
});

const selectedPackageEntries = async (repoRoot) => {
  const entries = [];
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = await tryReadJson(packageJsonPath);
  if (packageJson.ok && Array.isArray(packageJson.value.files)) {
    for (const entry of packageJson.value.files) entries.push({ source: entry, origin: 'package.json#files' });
  }
  const contractPath = path.join(repoRoot, 'package', 'package-contract.yaml');
  if (await pathExists(contractPath)) {
    const text = await readFile(contractPath, 'utf8');
    let inExcluded = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^excludedGeneratedState:/.test(line)) inExcluded = true;
      if (/^[A-Za-z][A-Za-z0-9]+:/.test(line) && !/^excludedGeneratedState:/.test(line)) inExcluded = false;
      if (inExcluded) continue;
      const sourceMatch = line.match(/^\s*-\s+source:\s+(.+?)\s*$/);
      const commonEntryMatch = line.match(/^\s*-\s+([A-Za-z0-9_./*{}${}:~!-]+)\s*$/);
      if (sourceMatch) entries.push({ source: sourceMatch[1].replace(/^"|"$/g, ''), origin: 'package-contract.yaml#source' });
      else if (commonEntryMatch && !line.includes('purpose:')) entries.push({ source: commonEntryMatch[1], origin: 'package-contract.yaml#entry' });
    }
  }
  return entries;
};

const summarizeGeneratedStateBoundary = async ({ repoRoot, findings }) => {
  const entries = await selectedPackageEntries(repoRoot);
  const generatedPrefixes = [
    '.moonshot-relay/',
    '.moonshot-state/',
    '.claude/logs/',
    '.claude/cache/',
    '.claude/traces/',
    '.claude/browser-artifacts/',
    '.claude/runtime-state.sqlite',
    '.claude/memorygraph/',
    '.codex/cache/',
    '.codex/sqlite/',
    '.codex/memories/',
    '.codex/sessions/',
    '.qwen/cache/',
    '.qwen/logs/',
    '.qwen/tmp/',
  ];
  const forbiddenMatches = entries.filter((entry) => {
    const source = normalizePath(entry.source);
    return generatedPrefixes.some((prefix) => source.startsWith(prefix))
      || /^docs\/implementation\/.+\/execution(\/|\*\*|$)/.test(source)
      || /(^|\/)[^/]*verdict[^/]*\.json$/i.test(source);
  });
  if (forbiddenMatches.length > 0) {
    findings.push({
      type: 'generated_state_selected_for_package',
      severity: 'blocking',
      check: 'generatedStateBoundary',
      matches: forbiddenMatches,
    });
  }
  return {
    status: forbiddenMatches.length > 0 ? 'blocked' : 'pass',
    selectedEntryCount: entries.length,
    forbiddenMatchCount: forbiddenMatches.length,
    forbiddenMatches,
    policySource: 'package/package-contract.yaml',
  };
};

const aggregateStatus = ({ findings, checks }) => {
  if (findings.some((finding) => finding.severity === 'blocking')) return 'blocked';
  if (findings.some((finding) => finding.severity === 'review')) return 'review_required';
  const degradedStatuses = new Set(['degraded', 'not_available', 'not_initialized', 'stale']);
  if (Object.values(checks).some((check) => check && typeof check === 'object' && degradedStatuses.has(check.status))) return 'degraded';
  if (findings.some((finding) => finding.severity === 'degraded')) return 'degraded';
  return 'pass';
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.command !== 'check') throw new Error(`Unknown command: ${args.command}\n${usage()}`);

  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const evidenceRoot = path.resolve(args.evidenceRoot || repoRoot);
  const runtimeSurfacePath = args.runtimeSurface
    ? resolveFromRoot(repoRoot, args.runtimeSurface)
    : path.join(repoRoot, 'package', 'runtime-surface.json');
  const runtimeSurface = await readJson(runtimeSurfacePath);
  const expectedRuntimeSurface = args.expectedRuntimeSurfaceJson
    ? JSON.parse(args.expectedRuntimeSurfaceJson)
    : runtimeSurface.publicRuntimeSkills;
  const findings = [];
  try {
    assertRuntimeSurfaceUnexpanded({
      before: expectedRuntimeSurface,
      after: runtimeSurface.publicRuntimeSkills || [],
    });
  } catch (error) {
    findings.push({
      type: 'runtime_surface_expanded',
      severity: 'blocking',
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const defaultLockPath = path.join(repoRoot, 'skills.lock.json');
  const lockPath = args.lock ? resolveFromRoot(repoRoot, args.lock) : defaultLockPath;
  const lock = args.lock
    ? await readJson(lockPath)
    : await pathExists(defaultLockPath)
      ? await readJson(defaultLockPath)
      : null;
  const skills = await auditSkillsLock({ repoRoot, lock, runtimeSurface });
  findings.push(...skills.findings);

  let systemNodeVersion = process.version;
  let runtimeNodeVersion = 'missing';
  let runtimeExecPath = 'missing';
  let runtimeSource = 'none';
  let checksumStatus = 'missing_runtime';
  const platform = process.platform;
  const arch = process.arch;

  try {
    const resolved = resolveRuntimeNode({ env: process.env });
    runtimeNodeVersion = resolved.version;
    runtimeExecPath = resolved.execPath;
    runtimeSource = resolved.source;
    checksumStatus = resolved.checksumStatus;
  } catch (error) {
    checksumStatus = error.code || 'error';
  }

  let sqliteStatus = 'healthy';
  try {
    const { loadSqliteDatabaseClass } = await import('./lib/sqlite-driver.mjs');
    const Database = await loadSqliteDatabaseClass();
    const tempDb = new Database(':memory:');
    tempDb.close();
  } catch (error) {
    sqliteStatus = 'runtime_sqlite_open_failed';
  }

  let memoryGraphStatus = 'healthy';
  const { spawnSync } = await import('node:child_process');
  const mgCheck = spawnSync('node', ['scripts/memorygraph-direct.mjs', 'health'], { encoding: 'utf8' });
  if (mgCheck.status !== 0) {
    const output = `${mgCheck.stdout} ${mgCheck.stderr}`.toLowerCase();
    if (output.includes('not found') || output.includes('missing') || output.includes('enoent')) {
      memoryGraphStatus = 'memorygraph_command_missing';
    } else {
      memoryGraphStatus = 'memorygraph_health_failed';
    }
  }

  let runtimeNodeStatus = 'healthy';
  if (runtimeNodeVersion === 'missing') {
    runtimeNodeStatus = 'runtime_node_missing';
  } else if (checksumStatus !== 'verified' && checksumStatus !== 'match') {
    if (checksumStatus === 'missing_runtime') {
      runtimeNodeStatus = 'runtime_node_missing';
    } else {
      runtimeNodeStatus = 'runtime_node_manifest_mismatch';
    }
  }

  const offlineReadiness = {
    runtimeNode: runtimeNodeStatus,
    sqlite: sqliteStatus,
    memoryGraph: memoryGraphStatus
  };

  const checks = {
    runtimeSurface: summarizeRuntimeSurface({
      repoRoot,
      runtimeSurface,
      runtimeSurfacePath,
      expectedRuntimeSurface,
      findings,
    }),
    skillsLock: summarizeSkillsLock({ repoRoot, lockPath, lock, skills }),
    labReadiness: await summarizeLabReadiness({ evidenceRoot, findings }),
    evalReadiness: await summarizeEvalReadiness({ evidenceRoot, findings }),
    researchReadiness: await summarizeResearchReadiness({ evidenceRoot, findings }),
    profileTrust: summarizeProfileTrust({ args, repoRoot, lockPath, runtimeSurfacePath }),
    generatedStateBoundary: await summarizeGeneratedStateBoundary({ repoRoot, findings }),
    systemNodeVersion,
    runtimeNodeVersion,
    runtimeExecPath,
    runtimeSource,
    platform,
    arch,
    checksumStatus,
    offlineReadiness,
  };

  const result = {
    schemaVersion: 'moonshot-doctor-readiness.v1',
    status: aggregateStatus({ findings, checks }),
    checks: {
      ...checks,
      runtimeSettings: checks.profileTrust.mode,
      repoRoot,
      evidenceRoot,
      lockPath,
      runtimeSurfacePath,
      gitState: 'caller_owned',
      schemaVersions: [1],
      packageDrift: 'runtime_surface_guarded',
    },
    findings,
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.status);
  if (result.status === 'blocked') process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
