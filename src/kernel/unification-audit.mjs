#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStandaloneLock, loadStandaloneCatalog, STANDALONE_CATALOG_REL, STANDALONE_LOCK_REL } from './standalone/catalog.mjs';
import { auditActiveRuntimeBoundary } from './runtime-boundary-audit.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRootDefault = path.resolve(path.dirname(scriptPath), '../..');
const CLASSIFICATIONS = new Set(['MIGRATED_STANDALONE', 'MIGRATED_PREWORK', 'ABSORBED_KERNEL', 'INTENTIONALLY_REMOVED']);
const LEGACY_NON_CATALOG_CAPABILITIES = new Set([
  'browser-verifier', 'frontend-design', 'normalize', 'polish', 'code-simplifier', 'build-error-resolver',
]);

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const finding = (code, message, details = {}) => ({ code, message, ...details });

const lockSignature = (lock) => JSON.stringify({
  schemaVersion: lock?.schemaVersion,
  scope: lock?.scope,
  catalogId: lock?.catalogId,
  catalogDigest: lock?.catalogDigest,
  skills: (lock?.skills || []).map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    skillPath: entry.skillPath,
    entrypoint: entry.entrypoint,
    exportName: entry.exportName,
    contentHash: entry.contentHash,
    cli: entry.cli,
    requiresKernelRun: entry.requiresKernelRun,
    mayMutateSource: entry.mayMutateSource,
    mayMutateGit: entry.mayMutateGit,
    mayMutateKnowledge: entry.mayMutateKnowledge,
    mayWriteArtifacts: entry.mayWriteArtifacts,
    permissions: entry.permissions,
  })),
});

const readPackageBins = async (repoRoot, relative) => {
  const pkg = await readJson(path.join(repoRoot, relative));
  return new Set(Object.keys(pkg.bin || {}));
};

const auditKernelPath = async (repoRoot, relative) => {
  const text = await readFile(path.join(repoRoot, relative), 'utf8');
  const forbidden = [
    ['relay-catalog-runtime-dependency', /catalog[\\/]moonshot-catalog\.json/],
    ['relay-state-runtime-dependency', /(?:MOONSHOT_RELAY_HOME|\.moonshot-relay[\\/]runtime-state\.sqlite)/],
    ['relay-phase-runtime-dependency', /scripts[\\/](?:prepare-phase-runner-state|phase-runner-session-audit)\.mjs/],
  ];
  return forbidden.filter(([, pattern]) => pattern.test(text)).map(([code]) => finding(code, `${relative} contains a legacy Relay runtime dependency.`));
};

const auditStandaloneAuthority = async (repoRoot, catalog) => {
  const findings = [];
  for (const entry of catalog.skills || []) {
    const text = await readFile(path.join(repoRoot, entry.entrypoint), 'utf8');
    const directAuthorityPatterns = [
      ['standalone-completion-authority', /recordCompletionDecision|persistCompletionDecision/],
      ['standalone-proof-authority', /recordVerification\s*\(|recordEvidencePack\s*\(/],
      ['standalone-review-authority', /recordReviewReceipt\s*\(|normalizeReviewReceipt/],
    ];
    for (const [code, pattern] of directAuthorityPatterns) {
      if (pattern.test(text)) findings.push(finding(code, `${entry.name} contains a direct Kernel authority path.`));
    }
    if (entry.kind === 'prework-utility' && /recordKnowledge|commitImportedProjectKnowledge|knowledge-commit/i.test(text)) {
      findings.push(finding('prework-knowledge-authority', `${entry.name} contains a direct knowledge commit path.`));
    }
    if (entry.mayMutateSource === true) findings.push(finding('standalone-source-mutation', `${entry.name} declares source mutation outside Kernel.`));
  }
  return findings;
};

export async function runUnificationAudit({ repoRoot = repoRootDefault } = {}) {
  const findings = [];
  const activeRuntimeBoundary = await auditActiveRuntimeBoundary({ repoRoot });
  findings.push(...activeRuntimeBoundary.findings);
  // Optimization is an explicit audit concern, not a dependency of the
  // default Kernel execution graph. Load it only when this optional audit is
  // actually invoked.
  const { validateOptimizationCycle } = await import('./optimization-cycle.mjs');
  const optimizationCycle = validateOptimizationCycle();
  findings.push(...optimizationCycle.findings.map((entry) => finding(`optimization-${entry.code}`, entry.message)));
  const legacy = await readJson(path.join(repoRoot, 'catalog', 'moonshot-catalog.json'));
  const matrix = await readJson(path.join(repoRoot, 'catalog', 'relay-replacement-matrix.json'));
  const matrixEntries = Array.isArray(matrix.entries) ? matrix.entries : [];
  const matrixByCapability = new Map(matrixEntries.map((entry) => [entry.capability, entry]));
  const legacyCapabilities = [
    ...(legacy.publicEntrypoints || []).map((entry) => entry.name),
    ...(legacy.internalSkillClusters || []).flatMap((cluster) => cluster.skills || []),
    ...LEGACY_NON_CATALOG_CAPABILITIES,
  ];
  for (const capability of legacyCapabilities) {
    const entry = matrixByCapability.get(capability);
    if (!entry) findings.push(finding('replacement-unknown', `No replacement classification exists for ${capability}.`, { capability }));
    else if (!CLASSIFICATIONS.has(entry.classification)) findings.push(finding('replacement-class-invalid', `Invalid replacement classification for ${capability}.`, { capability, classification: entry.classification }));
  }
  for (const entry of matrixEntries) {
    if (!entry.capability || !CLASSIFICATIONS.has(entry.classification) || !Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      findings.push(finding('replacement-entry-invalid', 'Every replacement entry needs capability, classification, and evidence.', { entry }));
    }
  }

  const standalone = await loadStandaloneCatalog({ repoRoot, validateSources: true });
  const lockPath = path.join(repoRoot, STANDALONE_LOCK_REL);
  const lock = await readJson(lockPath);
  const expectedLock = await buildStandaloneLock({ repoRoot, catalog: standalone, sourceCommit: lock.sourceCommit || '' });
  if (lockSignature(lock) !== lockSignature(expectedLock)) findings.push(finding('standalone-lock-drift', 'Standalone catalog, source entrypoints, and lock are not in parity.'));

  const standaloneNames = new Set(standalone.skills.map((entry) => entry.name));
  for (const entry of standalone.skills) {
    const replacement = matrixByCapability.get(entry.name);
    if (replacement && replacement.classification !== 'MIGRATED_STANDALONE') {
      findings.push(finding('standalone-replacement-mismatch', `${entry.name} is a standalone catalog member but its matrix classification is not MIGRATED_STANDALONE.`));
    }
  }
  const rootBins = await readPackageBins(repoRoot, 'package.json');
  const kernelBins = await readPackageBins(repoRoot, 'package/kernel/package.json');
  for (const entry of standalone.skills.filter((candidate) => candidate.cli?.enabled)) {
    if (rootBins.has(entry.cli.binName) && entry.cli.binName !== 'moon-relay-standalone') findings.push(finding('individual-standalone-bin', `Root package exposes ${entry.cli.binName} outside catalog materialization.`));
    if (kernelBins.has(entry.cli.binName) && entry.cli.binName !== 'moon-relay-standalone') findings.push(finding('individual-kernel-standalone-bin', `Kernel package exposes ${entry.cli.binName} outside catalog materialization.`));
  }

  for (const relative of ['bin/moon-relay-kernel.mjs', 'scripts/kernel/control-plane.mjs']) {
    findings.push(...await auditKernelPath(repoRoot, relative));
  }
  findings.push(...await auditStandaloneAuthority(repoRoot, standalone));

  const manifest = await readJson(path.join(repoRoot, 'package', 'kernel', 'manifest.json'));
  const kernelSkillsText = await readFile(path.join(repoRoot, 'catalog', 'kernel-skills.json'), 'utf8');
  const forbiddenKernelPayload = (manifest.include || []).filter((entry) => /catalog[\\/]moonshot-catalog|skills[\\/](?:moonshot-|product-orchestrator)|scripts[\\/](?:prepare-phase-runner-state|phase-runner-session-audit)/i.test(entry));
  if (forbiddenKernelPayload.length > 0) findings.push(finding('kernel-payload-relay-surface', 'Kernel package manifest still ships a legacy Relay runtime surface.', { entries: forbiddenKernelPayload }));
  const providerPolicy = manifest.providerRuntimePolicy || {};
  if (providerPolicy.mode !== 'native-provider'
    || providerPolicy.managedRuntime !== 'kernel-node-only'
    || providerPolicy.executionLayer !== 'native-surface'
    || providerPolicy.runtimeIsolation !== 'kernel-state-only'
    || providerPolicy.completionAuthority !== 'kernel') {
    findings.push(finding('kernel-native-provider-policy-missing', 'Kernel package must declare native surface dispatch with isolated Kernel state and Kernel completion authority.'));
  }
  const managedProviderPayload = (manifest.include || []).filter((entry) => /(?:providers[\\/](?:claude|codex|qwen|antigravity)|(?:claude|codex|qwen|antigravity)\\.(?:exe|app|bin))$/i.test(entry));
  if (managedProviderPayload.length > 0) findings.push(finding('kernel-managed-provider-payload', 'Kernel package must not ship provider binaries or provider application bundles.', { entries: managedProviderPayload }));
  const kernelAuthorityText = await Promise.all([
    'scripts/kernel/control-plane.mjs',
    'scripts/kernel/state-store.mjs',
    'scripts/kernel/standalone/kernel-commit.mjs',
  ].map((relative) => readFile(path.join(repoRoot, relative), 'utf8')));
  const authorityText = kernelAuthorityText.join('\n');
  const rootPackage = await readJson(path.join(repoRoot, 'package.json'));
  const declaredRegressionGates = [
    'lint:kernel', 'test:kernel-reliability', 'test:kernel-lifecycle', 'test:kernel-unification', 'test:package', 'test:kernel', 'test',
  ].every((name) => typeof rootPackage.scripts?.[name] === 'string');

  const gates = {
    G1_catalogSoleMembershipAuthority: standalone.schemaVersion === 2 && standalone.skills.length > 0,
    G2_catalogPackageLockCliParity: findings.every((item) => !['standalone-lock-drift', 'individual-standalone-bin', 'individual-kernel-standalone-bin'].includes(item.code)),
    G3_newStandaloneCatalogOnly: standaloneNames.size === new Set(standalone.skills.map((entry) => entry.name)).size,
    G4_standaloneDoesNotPolluteKernelWorkflow: standalone.skills.every((entry) => entry.requiresKernelRun === false && entry.mayMutateSource === false)
      && !standalone.skills.some((entry) => new RegExp(`(?:^|[\\"'])${entry.name}(?:[\\"']|$)`).test(kernelSkillsText)),
    G5_sourceMutationOutsideKernelZero: findings.every((item) => item.code !== 'standalone-source-mutation'),
    G6_kernelGeneratedMutationOnlyCloseout: authorityText.includes('admitKernelMutation')
      && authorityText.includes('recordMutationProvenance')
      && authorityText.includes('mutationAdmissionDigest'),
    G7_analysisUtilitiesMigrated: standaloneNames.has('explain-diff-html') && standaloneNames.has('ui-audit'),
    G8_kernelNativeDomainProofReview: ['kernel-conditional-frontend-guidance', 'kernel-browser-proof-adapter', 'kernel-security-review-policy'].every((name) => kernelSkillsText.includes(name)),
    G9_nonAuthorityBoundaries: findings.every((item) => !/^standalone-|^prework-/.test(item.code)),
    G10_productArchitectureExtraction: standaloneNames.has('product-definition') && standaloneNames.has('architecture-artifacts'),
    G11_replacementMatrixComplete: !findings.some((item) => item.code.startsWith('replacement-')),
    G12_kernelSingleAuthority: authorityText.includes('recordCompletionDecision')
      && authorityText.includes('recordVerification')
      && authorityText.includes('recordReviewReceipt'),
    G13_relayRuntimeDependencyZero: activeRuntimeBoundary.status === 'pass'
      && !findings.some((item) => item.code.includes('relay-runtime-dependency') || item.code === 'kernel-payload-relay-surface' || item.code === 'kernel-managed-provider-payload' || item.code === 'kernel-native-provider-policy-missing'),
    G14_regressionGateDeclared: declaredRegressionGates,
    G15_optimizationCycleComplete: optimizationCycle.status === 'pass' && optimizationCycle.cycleStatus === 'COMPLETE' && optimizationCycle.highRoiUnresolved.length === 0,
  };
  const status = findings.length === 0 && Object.values(gates).every(Boolean) ? 'pass' : 'fail';
  return {
    schemaVersion: 1,
    status,
    catalog: STANDALONE_CATALOG_REL,
    lock: STANDALONE_LOCK_REL,
    matrix: 'catalog/relay-replacement-matrix.json',
    optimizationCycle,
    legacyCapabilityCount: legacyCapabilities.length,
    standaloneCapabilityCount: standalone.skills.length,
    gates,
    findings,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = process.argv.includes('--repo-root')
    ? path.resolve(process.argv[process.argv.indexOf('--repo-root') + 1])
    : repoRootDefault;
  const testFlag = process.argv.indexOf('--with-tests');
  const testFiles = testFlag >= 0 ? process.argv.slice(testFlag + 1).filter((value) => !value.startsWith('--')) : [];
  runUnificationAudit({ repoRoot })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'pass') {
        process.exitCode = 2;
        return;
      }
      if (testFiles.length > 0) {
        const testResult = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: repoRoot, stdio: 'inherit' });
        process.exitCode = testResult.status ?? 1;
      } else {
        process.exitCode = 0;
      }
    })
    .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
