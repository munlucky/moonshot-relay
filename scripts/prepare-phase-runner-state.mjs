#!/usr/bin/env node
import crypto from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { resolveRuntimeStatePath } from './lib/runtime-state-root.mjs';
import { acquireRunLease, recordResumeSnapshot, recordRuntimeEvent } from './lib/runtime-state-store.mjs';
import { gitStatusBranchLine } from './lib/git-safe.js';
import { markdownPlanCompatibility, validatePlanGraph } from './lib/plan-graph.mjs';
import { resolveProjectIdentity, sanitizeId } from './project-identity.mjs';

const usage = () => `Usage: node scripts/prepare-phase-runner-state.mjs [--plan-dir <dir>] [--master-plan <file>] [--status-file <file>] [--execution-root <dir>] [--run-id <id>] [--goal-id <id>] [--workspace-id <id>] [--allow-parallel] [--lease-ttl-ms <ms>] [--dry-run] [--json]`;

const parseArgs = (argv) => {
  const options = {
    planDir: '',
    masterPlan: '',
    statusFile: '',
    executionRoot: '',
    runId: '',
    goalId: '',
    workspaceId: '',
    allowParallel: false,
    leaseTtlMs: '',
    dryRun: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan-dir') {
      options.planDir = argv[++index] || '';
    } else if (arg === '--master-plan') {
      options.masterPlan = argv[++index] || '';
    } else if (arg === '--status-file') {
      options.statusFile = argv[++index] || '';
    } else if (arg === '--execution-root') {
      options.executionRoot = argv[++index] || '';
    } else if (arg === '--run-id') {
      options.runId = argv[++index] || '';
    } else if (arg === '--goal-id') {
      options.goalId = argv[++index] || '';
    } else if (arg === '--workspace-id') {
      options.workspaceId = argv[++index] || '';
    } else if (arg === '--allow-parallel') {
      options.allowParallel = true;
    } else if (arg === '--lease-ttl-ms') {
      options.leaseTtlMs = argv[++index] || '';
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  return options;
};

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const toPortable = (target) => target.split(path.sep).join('/');

const toRepoPortable = (repoRoot, target) => {
  const relative = path.relative(repoRoot, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return toPortable(relative);
  }
  return toPortable(target);
};

const shortHash = (value) => crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);

const defaultRunId = () => {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `phase-runner-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
};

const planSlugFromDir = (repoRoot, planDir) => {
  if (!planDir) return 'phase-runner';
  const relativePlanDir = toPortable(path.relative(repoRoot, planDir));
  const sourceRoadmapPrefix = 'docs/public/roadmaps/';
  if (relativePlanDir.startsWith(sourceRoadmapPrefix)) {
    const [roadmapSlug] = relativePlanDir.slice(sourceRoadmapPrefix.length).split('/');
    return roadmapSlug || path.basename(planDir);
  }
  return path.basename(planDir);
};

const defaultExecutionRoot = (repoRoot, planDir, runId) => {
  const resolved = resolveProjectIdentity({ cwd: repoRoot });
  const planSlug = sanitizeId(planSlugFromDir(repoRoot, planDir), 'phase-plan');
  const runSlug = sanitizeId(runId || 'local-run', 'run');
  return path.join(resolved.namespaces.planExecutionRoot, planSlug, 'runs', runSlug, 'execution');
};

const discoverPlanDirs = async (repoRoot) => {
  const roots = [];
  try {
    roots.push(resolveProjectIdentity({ cwd: repoRoot }).namespaces.planningPackageRoot);
  } catch {
    // Project identity failures are reported later by runtime-state helpers.
  }
  roots.push(path.join(repoRoot, 'docs', 'implementation'));

  const candidates = [];
  for (const rootDir of roots) {
    if (!rootDir || !await exists(rootDir)) {
      continue;
    }
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(rootDir, entry.name);
      const files = await readdir(candidate);
      if (files.some((file) => /^00-master-plan-v\d+\.md$/.test(file))) {
        candidates.push(candidate);
      }
    }
  }
  return candidates.sort();
};

const chooseMasterPlan = async (planDir, explicitMasterPlan) => {
  if (explicitMasterPlan) {
    return explicitMasterPlan;
  }
  const files = await readdir(planDir);
  const masters = files.filter((file) => /^00-master-plan-v\d+\.md$/.test(file)).sort();
  if (masters.length !== 1) {
    return null;
  }
  return path.join(planDir, masters[0]);
};

const masterPlanVersion = (masterPlan) => {
  const match = /^00-master-plan-(v\d+)\.md$/.exec(path.basename(masterPlan || ''));
  return match ? match[1] : '';
};

const listPhaseDocs = async (planDir, masterPlan = '') => {
  const files = await readdir(planDir);
  const version = masterPlanVersion(masterPlan);
  return files
    .filter((file) => /^\d{2}-.*\.md$/.test(file) && !file.startsWith('00-'))
    .filter((file) => !version || file.endsWith(`-${version}.md`))
    .sort();
};

const listReviewArtifacts = async (planDir) => {
  const reviewRoot = path.join(planDir, 'planning-loop');
  if (!await exists(reviewRoot)) {
    return [];
  }
  const files = await readdir(reviewRoot);
  return files.filter((file) => /(audit|review|quality|improvement)/i.test(file)).sort();
};

const titleFromPhaseFile = (file) => {
  const match = /^(\d{2})-(.*)-v\d+\.md$/.exec(file);
  if (!match) {
    return file;
  }
  return match[2]
    .split('-')
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
};

const phaseNumberFromFile = (file, fallbackIndex) => {
  const match = /^(\d{2})-/.exec(file);
  return match ? Number.parseInt(match[1], 10) : fallbackIndex + 1;
};

const phaseIdFromFile = (file, fallbackIndex) => {
  const number = phaseNumberFromFile(file, fallbackIndex);
  return String(number).padStart(2, '0');
};

const readIfExists = async (target) => {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return '';
  }
};

const classifyPlanRoot = ({ repoRoot, planDir }) => {
  const relativePlanDir = toPortable(path.relative(repoRoot, planDir || ''));
  let kind = 'external_or_unknown';
  if (relativePlanDir.startsWith('docs/public/roadmaps/')) {
    kind = 'source_roadmap';
  } else if (relativePlanDir.startsWith('docs/implementation/')) {
    kind = 'tracked_source_design';
  } else {
    try {
      const planningRoot = resolveProjectIdentity({ cwd: repoRoot }).namespaces.planningPackageRoot;
      const relativeToPlanningRoot = path.relative(planningRoot, planDir || '');
      if (relativeToPlanningRoot && !relativeToPlanningRoot.startsWith('..') && !path.isAbsolute(relativeToPlanningRoot)) {
        kind = 'account_project_planning';
      }
    } catch {
      // Keep external_or_unknown; runtime-state capability checks report identity failures separately.
    }
  }

  const recommendation = kind === 'source_roadmap'
    ? {
      status: 'recommended',
      reason: 'docs/public/roadmaps packages are durable source roadmaps; materialize or select an account-root implementation package when execution scratch should be operational-only.',
      defaultExecutionScratch: 'account_project_execution_root',
    }
    : null;

  return {
    kind,
    relativePath: relativePlanDir || '.',
    executionPackageRecommendation: recommendation,
  };
};

const bridgeRequiredEntries = [
  'scripts/runtime-state.mjs',
  'scripts/prepare-phase-runner-state.mjs',
  'scripts/knowledge-context-build.mjs',
  'tools/sandbox/policy.mjs',
  'verification.contract.yaml',
  '.moonshot-relay/.gitignore',
];

const commandArg = (value = '') => `"${String(value).replaceAll('"', '\\"')}"`;

const buildRuntimeBridgeStatus = async ({ repoRoot, planDir }) => {
  const sourceCheckout = await exists(path.join(repoRoot, 'package', 'package-contract.yaml'))
    && await exists(path.join(repoRoot, 'scripts', 'install-project-runtime-bridge.mjs'));
  if (sourceCheckout) {
    return {
      status: 'not_applicable',
      blockingSeverity: 'none',
      targetRoot: toPortable(repoRoot),
      requiredEntries: bridgeRequiredEntries,
      missingEntries: [],
      recoveryCommand: '',
      dryRunRecoveryCommand: '',
      reason: 'source checkout owns canonical runtime files directly',
    };
  }

  const missingEntries = [];
  for (const entry of bridgeRequiredEntries) {
    if (!await exists(path.join(repoRoot, ...entry.split('/')))) {
      missingEntries.push(entry);
    }
  }
  const packageArg = planDir ? ` --plan-package ${commandArg(toPortable(planDir))}` : '';
  const recoveryCommand = `moonshot-relay bridge --target ${commandArg(toPortable(repoRoot))}${packageArg} --json`;
  return {
    status: missingEntries.length > 0 ? 'missing' : 'ok',
    blockingSeverity: missingEntries.length > 0 ? 'warning' : 'none',
    targetRoot: toPortable(repoRoot),
    requiredEntries: bridgeRequiredEntries,
    missingEntries,
    recoveryCommand,
    dryRunRecoveryCommand: recoveryCommand.replace(' --json', ' --dry-run --json'),
  };
};

const findPlanGraphPath = async (planDir) => {
  for (const name of ['plan-graph.json', 'plan.graph.json']) {
    const candidate = path.join(planDir, name);
    if (await exists(candidate)) return candidate;
  }
  return '';
};

const buildPlanGraphStatus = async ({ repoRoot, planDir, phaseDocs, allowParallel, errors }) => {
  const graphPath = planDir ? await findPlanGraphPath(planDir) : '';
  if (!graphPath) {
    const compatibility = markdownPlanCompatibility({ phaseDocs });
    const result = {
      status: 'markdown_sequential',
      executionMode: compatibility.executionMode,
      parallelAllowed: false,
      graphPath: '',
      phaseCount: compatibility.phaseCount,
      findings: [],
      reason: compatibility.reason,
    };
    if (allowParallel) {
      errors.push('Parallel execution requires validated plan graph metadata; markdown-only phase packages are sequential.');
      result.findings.push({
        type: 'parallel_without_graph',
        severity: 'blocking',
        reason: 'allowParallel was requested but no plan-graph.json exists',
      });
    }
    return result;
  }

  try {
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    const validation = validatePlanGraph(graph, { expectedPhaseDocs: phaseDocs });
    const result = {
      status: validation.status === 'pass' ? 'validated_graph' : 'blocked_graph',
      executionMode: 'graph',
      parallelAllowed: validation.status === 'pass',
      graphPath: toRepoPortable(repoRoot, graphPath),
      phaseCount: validation.phaseCount,
      findings: validation.findings,
    };
    if (validation.status !== 'pass') {
      errors.push(`Plan graph validation failed: ${validation.findings.map((finding) => finding.type).join(', ')}`);
    }
    return result;
  } catch (error) {
    errors.push(`Plan graph could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      status: 'blocked_graph',
      executionMode: 'graph',
      parallelAllowed: false,
      graphPath: toRepoPortable(repoRoot, graphPath),
      phaseCount: 0,
      findings: [{ type: 'graph_parse_error', severity: 'blocking' }],
    };
  }
};

const includesPassingStatus = (content) => /(?:^|\n)\s*Status:\s*(?:pass|passed|ready|complete)\b/i.test(content);

const phaseDocClaimsComplete = (content) => /(?:^|\n)\s*Status:\s*complete\b/i.test(content)
  || /(?:^|\n)##\s+Phase\s+\d+\s+Closeout[\s\S]*?(?:^|\n)\s*Status:\s*complete\b/i.test(content);

const phaseDocIsOptionalBacklog = ({ masterText = '', phaseDoc = '', phaseText = '' } = {}) => {
  const escapedPhaseDoc = phaseDoc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const masterLinePattern = new RegExp(`^.*${escapedPhaseDoc}.*(?:optional|backlog).*explicitly\\s+pulled.*$`, 'im');
  return masterLinePattern.test(masterText)
    || /(?:^|\n)#\s+Phase\s+\d+\s+-.*Optional\b/i.test(phaseText)
    || /optional\s+backlog\s+unless\s+explicitly\s+pulled\s+into\s+(?:implementation\s+)?scope/i.test(phaseText);
};

const inspectPhaseCloseout = async ({ repoRoot, planDir, executionRoot, phaseDoc, fallbackIndex }) => {
  const phaseId = phaseIdFromFile(phaseDoc, fallbackIndex);
  const phaseText = await readIfExists(path.join(planDir, phaseDoc));
  const phaseRoot = path.join(executionRoot, `phase-${phaseId}`);
  const scorecardPath = path.join(phaseRoot, 'SCORECARD.md');
  const qaReportPath = path.join(phaseRoot, 'QA_REPORT.md');
  const handoffPath = path.join(phaseRoot, 'HANDOFF.md');
  const scorecard = await readIfExists(scorecardPath);
  const qaReport = await readIfExists(qaReportPath);
  const handoff = await readIfExists(handoffPath);
  const evidence = {
    phaseDocClaimsComplete: phaseDocClaimsComplete(phaseText),
    scorecard: scorecard ? includesPassingStatus(scorecard) : false,
    qaReport: qaReport ? includesPassingStatus(qaReport) : false,
    handoff: handoff ? includesPassingStatus(handoff) : false,
    paths: {
      scorecard: toRepoPortable(repoRoot, scorecardPath),
      qaReport: toRepoPortable(repoRoot, qaReportPath),
      handoff: toRepoPortable(repoRoot, handoffPath),
    },
  };
  return {
    phaseId,
    complete: evidence.phaseDocClaimsComplete && evidence.scorecard && evidence.qaReport && evidence.handoff,
    evidence,
  };
};

const buildPhaseStates = async ({ repoRoot, planDir, executionRoot, phaseDocs }) => {
  if (!planDir || phaseDocs.length === 0) {
    return [];
  }
  const inspected = [];
  const masterFiles = (await readdir(planDir)).filter((file) => /^00-master-plan-v\d+\.md$/.test(file)).sort();
  const masterText = masterFiles.length === 1 ? await readIfExists(path.join(planDir, masterFiles[0])) : '';
  for (let index = 0; index < phaseDocs.length; index += 1) {
    inspected.push(await inspectPhaseCloseout({
      repoRoot,
      planDir,
      executionRoot,
      phaseDoc: phaseDocs[index],
      fallbackIndex: index,
    }));
  }
  const optionalBacklog = [];
  for (let index = 0; index < phaseDocs.length; index += 1) {
    const phaseText = await readIfExists(path.join(planDir, phaseDocs[index]));
    optionalBacklog.push(phaseDocIsOptionalBacklog({
      masterText,
      phaseDoc: phaseDocs[index],
      phaseText,
    }));
  }
  const activeIndex = inspected.findIndex((phase, index) => !phase.complete && !optionalBacklog[index]);

  return phaseDocs.map((file, index) => ({
    number: phaseNumberFromFile(file, index),
    doc: file,
    title: titleFromPhaseFile(file),
    status: inspected[index]?.complete
      ? 'complete'
      : optionalBacklog[index]
        ? 'optional_backlog'
        : index === activeIndex
          ? 'in_progress'
          : 'pending',
    attempts: {
      total: inspected[index]?.complete ? 1 : 0,
      lastOutcome: inspected[index]?.complete ? 'phase-local-closeout-pass' : '',
      lastUpdatedAt: '',
    },
    closeoutEvidence: inspected[index]?.evidence || null,
  }));
};

const hasAheadClaim = (masterText) => /ahead\s+\d+/i.test(masterText) || /unpushed\s+commit/i.test(masterText);

const gitBranchLine = async () => gitStatusBranchLine(process.cwd());

const buildStatusYaml = (result) => {
  const lines = [
    `planDir: "${result.planDir}"`,
    `masterPlan: "${result.masterPlan}"`,
    `runId: "${result.runId}"`,
    `goalId: "${result.goalId}"`,
    `workspaceId: "${result.workspaceId}"`,
    `activeExecutionStatus: "${result.activeExecutionStatus}"`,
    `activePhaseDoc: "${result.activePhaseDoc}"`,
    `status: "${result.status}"`,
    `preparedAt: "${result.preparedAt}"`,
    'phaseDocs:',
  ];
  for (const file of result.phaseDocs) {
    lines.push(`  - "${file}"`);
  }
  lines.push('phases:');
  for (const phase of result.phases) {
    lines.push(`  - number: ${phase.number}`);
    lines.push(`    title: "${phase.title.replaceAll('"', '\\"')}"`);
    lines.push(`    doc: "${phase.doc}"`);
    lines.push(`    status: "${phase.status}"`);
    lines.push('    attempts:');
    lines.push(`      total: ${phase.attempts.total}`);
    lines.push(`      lastOutcome: "${phase.attempts.lastOutcome}"`);
    lines.push(`      lastUpdatedAt: "${phase.attempts.lastUpdatedAt}"`);
  }
  lines.push('warnings:');
  for (const warning of result.warnings) {
    lines.push(`  - "${warning.replaceAll('"', '\\"')}"`);
  }
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const warnings = [];
  const errors = [];

  let planDir = options.planDir ? path.resolve(options.planDir) : '';
  if (!planDir) {
    const discovered = await discoverPlanDirs(repoRoot);
    if (discovered.length === 1) {
      planDir = discovered[0];
    } else if (discovered.length === 0) {
      errors.push('No account-root planning package or docs/implementation plan package with 00-master-plan-v*.md was found.');
    } else {
      errors.push(`Implicit plan resolution is ambiguous: ${discovered.map((dir) => toPortable(path.relative(repoRoot, dir))).join(', ')}`);
    }
  }

  let masterPlan = '';
  let phaseDocs = [];
  let reviewArtifacts = [];
  if (planDir && await exists(planDir)) {
    masterPlan = await chooseMasterPlan(planDir, options.masterPlan ? path.resolve(options.masterPlan) : '');
    if (!masterPlan) {
      errors.push('Plan package must contain exactly one 00-master-plan-v*.md or pass --master-plan.');
    } else if (!await exists(masterPlan)) {
      errors.push(`Master plan does not exist: ${toPortable(masterPlan)}`);
    }
    phaseDocs = await listPhaseDocs(planDir, masterPlan);
    reviewArtifacts = await listReviewArtifacts(planDir);
  } else if (planDir) {
    errors.push(`Plan directory does not exist: ${toPortable(planDir)}`);
  }

  if (phaseDocs.length === 0) {
    errors.push('Plan package has no phase docs matching NN-*.md.');
  }
  if (reviewArtifacts.length === 0) {
    warnings.push('No planning-loop review/audit artifacts were found; delegated review evidence is missing.');
  }

  if (masterPlan && await exists(masterPlan)) {
    const masterText = await readFile(masterPlan, 'utf8');
    const branch = await gitBranchLine();
    if (hasAheadClaim(masterText) && !/ahead\s+\d+/.test(branch)) {
      warnings.push('Master plan mentions unpushed/ahead commits, but current git branch is not ahead.');
    }
  }

  const statusFile = options.statusFile
    ? path.resolve(options.statusFile)
    : resolveRuntimeStatePath('docs', 'phase-status.yaml');
  const runId = options.runId || defaultRunId();
  const executionRoot = options.executionRoot
    ? path.resolve(options.executionRoot)
    : defaultExecutionRoot(repoRoot, planDir, runId);
  const closeoutFile = path.join(executionRoot, 'phase-runner-readiness.json');
  const goalId = options.goalId || (planDir ? path.basename(planDir) : 'phase-runner');
  const workspaceId = options.workspaceId || `workspace-${shortHash(repoRoot)}`;
  const planRoot = classifyPlanRoot({ repoRoot, planDir });
  if (planRoot.kind === 'source_roadmap') {
    warnings.push('Plan directory is a tracked source roadmap; execution scratch will remain under account-root project execution, and an account-root implementation package is recommended for ordinary implementation work.');
  }
  const runtimeBridgeStatus = await buildRuntimeBridgeStatus({ repoRoot, planDir });
  const planGraphStatus = await buildPlanGraphStatus({
    repoRoot,
    planDir,
    phaseDocs,
    allowParallel: options.allowParallel,
    errors,
  });
  const status = errors.length > 0 ? 'blocked' : reviewArtifacts.length === 0 ? 'docs_only' : 'ready';
  const phases = await buildPhaseStates({
    repoRoot,
    planDir,
    executionRoot,
    phaseDocs,
  });
  const activePhase = phases.find((phase) => phase.status === 'in_progress') || null;
  const preparedAt = new Date().toISOString();
  const result = {
    status,
    activeExecutionStatus: errors.length > 0 ? 'blocked' : activePhase ? 'active' : 'all_phases_projected_complete',
    activePhaseDoc: activePhase?.doc || '',
    preparedAt,
    dryRun: options.dryRun,
    runId,
    goalId,
    workspaceId,
    allowParallel: options.allowParallel,
    leaseTtlMs: options.leaseTtlMs,
    planRootKind: planRoot.kind,
    planRoot,
    executionPackageRecommendation: planRoot.executionPackageRecommendation,
    planGraphStatus,
    runtimeBridgeStatus,
    planDir: planDir ? toRepoPortable(repoRoot, planDir) || '.' : '',
    masterPlan: masterPlan ? toRepoPortable(repoRoot, masterPlan) : '',
    phaseDocs,
    phases,
    reviewArtifacts,
    plannedWrites: [
      toRepoPortable(repoRoot, statusFile),
      toRepoPortable(repoRoot, closeoutFile),
    ],
    warnings,
    errors,
  };
  const identity = {
    planDir: result.planDir,
    masterPlan: result.masterPlan,
    workspacePathHash: shortHash(repoRoot),
  };

  if (!options.dryRun && errors.length === 0) {
    result.runLease = await acquireRunLease({
      runId,
      goalId,
      workspaceId,
      identity,
      allowParallel: options.allowParallel,
      leaseTtlMs: options.leaseTtlMs,
    });
    if (result.runLease.status === 'blocked') {
      result.status = 'blocked';
      errors.push(result.runLease.reason);
    }
  }

  if (!options.dryRun && errors.length === 0) {
    try {
      result.phaseStartEvent = await recordRuntimeEvent({
        runId,
        goalId,
        workspaceId,
        eventType: 'phase.start',
        severity: 'info',
        payload: {
          planDir: result.planDir,
          masterPlan: result.masterPlan,
          phaseDoc: result.activePhaseDoc,
          phaseNumber: activePhase?.number ?? null,
          workspaceId,
        },
        identity,
      });
      result.runtimeSnapshot = await recordResumeSnapshot({
        runId,
        goalId,
        workspaceId,
        status: result,
        resumeBrief: {
          nextAction: result.activePhaseDoc,
          currentBlocker: '',
          lineage: [result.planDir, result.masterPlan],
        },
        identity,
      });
    } catch (error) {
      warnings.push(`Runtime resume snapshot was not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    await mkdir(path.dirname(statusFile), { recursive: true });
    await mkdir(executionRoot, { recursive: true });
    await writeFile(statusFile, buildStatusYaml(result));
    await writeFile(closeoutFile, `${JSON.stringify(result, null, 2)}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.planDir || '(no plan)'}`);
    for (const warning of warnings) {
      console.log(`warning: ${warning}`);
    }
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
  }

  if (errors.length > 0) {
    process.exitCode = 2;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
