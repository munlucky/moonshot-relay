#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(root, 'docs', 'capability-assets');
const schemaPath = path.join(assetRoot, 'asset.schema.json');
const catalogPath = path.join(assetRoot, 'catalog.yaml');
const taxonomyPath = path.join(assetRoot, 'taxonomy.yaml');
const epochsPath = path.join(assetRoot, 'epochs.yaml');
const inventoryPath = path.join(assetRoot, 'inventory-current.yaml');
const coverageLedgerPath = path.join(assetRoot, 'coverage-ledger.yaml');
const baselineDocPath = path.join(assetRoot, 'CAPABILITY_ASSET_BASELINE.md');
const rootBaselineDocPath = path.join(root, 'CAPABILITY_ASSET_BASELINE.md');
const errors = [];
const warnings = [];
const sourceMigration = readJson(path.join(root, 'catalog/kernel-capability-surface-migrations.json'), 'typed capability surface migrations');
const runtimeBuild = readJson(path.join(root, 'dist/runtime-build.json'), 'typed runtime build');
const runtimeFiles = new Map((runtimeBuild?.files || []).map(item => [item.source, item]));

// Frozen capability records retain their original paths. This explicit catalog
// connects those records to the current source and compiler-owned output.
function currentPathExists(filePath) {
  const migration = sourceMigration?.migrations?.[filePath];
  if (!migration) return fs.existsSync(path.join(root, filePath));
  if (!isText(migration.source) || !isText(migration.output)) return false;
  const emitted = runtimeFiles.get(migration.source);
  return emitted?.output === migration.output
    && fs.existsSync(path.join(root, migration.source))
    && fs.existsSync(path.join(root, migration.output));
}

if (fs.existsSync(rootBaselineDocPath)) {
  addError('root CAPABILITY_ASSET_BASELINE.md is forbidden; canonical document is docs/capability-assets/CAPABILITY_ASSET_BASELINE.md');
}
if (!fs.existsSync(baselineDocPath)) {
  addError('canonical CAPABILITY_ASSET_BASELINE.md missing at docs/capability-assets/CAPABILITY_ASSET_BASELINE.md');
}

function addError(message) {
  errors.push(message);
}

function readText(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    addError(label + ': ' + error.message);
    return '';
  }
}

function readJson(filePath, label) {
  const text = readText(filePath, label);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    addError(label + ' is not JSON-compatible YAML: ' + error.message);
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTextArray(value) {
  return Array.isArray(value) && value.every(isText);
}

function requireObject(value, label) {
  if (!isObject(value)) addError(label + ' must be an object');
  return isObject(value);
}

function requireText(value, label) {
  if (!isText(value)) addError(label + ' must be a non-empty string');
}

function requireTextArray(value, label, allowEmpty = true) {
  if (!Array.isArray(value) || !value.every(isText) || (!allowEmpty && value.length === 0)) {
    addError(label + ' must be a ' + (allowEmpty ? '' : 'non-empty ') + 'string array');
  }
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) return;
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) addError(label + ' has unexpected key ' + key);
  }
  for (const key of keys) {
    if (!(key in value)) addError(label + ' is missing ' + key);
  }
}

function safeRelativePath(value, label) {
  if (!isText(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('..') || /[\r\n]/.test(value)) {
    addError(label + ' must be a safe relative path');
    return false;
  }
  return true;
}

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

function commitExists(commit, label) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    addError(label + ' must be a full 40-character lowercase Git SHA');
    return false;
  }
  const result = git(['cat-file', '-e', commit + '^{commit}']);
  if (result.status !== 0) {
    addError(label + ' does not resolve to a commit: ' + commit);
    return false;
  }
  return true;
}

function pathAtCommit(commit, relativePath, label) {
  if (!commitExists(commit, label + ' commit') || !safeRelativePath(relativePath, label + ' path')) return;
  const result = git(['cat-file', '-e', commit + ':' + relativePath]);
  if (result.status !== 0) addError(label + ' is absent at ' + commit + ': ' + relativePath);
}

function checkProofItem(item, label, isTest = false) {
  requireObject(item, label);
  if (!isObject(item)) return;
  requireText(item.id, label + '.id');
  requireText(item.path, label + '.path');
  requireText(item.purpose, label + '.purpose');
  safeRelativePath(item.path, label + '.path');
  if (item.commandRef !== undefined && item.commandRef !== null) requireText(item.commandRef, label + '.commandRef');

  if (isTest) {
    if (item.status !== undefined) {
      addError(label + ' must not use legacy status field; use referenceStatus and executionStatus only');
    }
    requireText(item.referenceStatus, label + '.referenceStatus');
    if (!['verified', 'missing'].includes(item.referenceStatus)) {
      addError(label + '.referenceStatus must be verified or missing');
    }
    requireText(item.executionStatus, label + '.executionStatus');
    if (!['executed-pass', 'executed-fail', 'historical-pass', 'not-run-at-freeze', 'unknown'].includes(item.executionStatus)) {
      addError(label + '.executionStatus is not a supported execution status: ' + item.executionStatus);
    }
  } else {
    if (item.status !== undefined && !['verified', 'partial', 'missing', 'historical', 'unknown'].includes(item.status)) {
      addError(label + '.status is not a supported proof status');
    }
  }

  if (item.referenceStatus === 'verified' && isText(item.path) && !currentPathExists(item.path)) {
    addError(label + ' path does not exist in the current checkout: ' + item.path);
  }
}

function checkManifest(manifest, manifestPath, schema, epochCommits, allIds, allSubcapabilityIds, collectedSubcapabilities) {
  const label = manifestPath.replace(root + path.sep, '').replaceAll(path.sep, '/');
  if (!isObject(manifest)) return;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const allowed = Object.keys(schema?.properties || {});
  exactKeys(manifest, allowed, label);
  for (const key of required) {
    if (!(key in manifest)) addError(label + ' is missing required field ' + key);
  }

  requireText(manifest.id, label + '.id');
  const directoryId = path.basename(path.dirname(manifestPath));
  if (manifest.id !== directoryId) addError(label + '.id must match directory ' + directoryId);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id || '')) addError(label + '.id is not kebab-case');
  if (manifest.schemaVersion !== 1) addError(label + '.schemaVersion must be 1');
  requireText(manifest.name, label + '.name');
  requireText(manifest.summary, label + '.summary');
  if (!['WORK', 'TRUST', 'KNOWLEDGE', 'EXECUTION', 'INTELLIGENCE', 'OPTIMIZATION', 'PRODUCTIVITY'].includes(manifest.category)) {
    addError(label + '.category is invalid');
  }
  if (!['CORE', 'HOST', 'OPTIONAL', 'LIBRARY', 'REFERENCE', 'DEPRECATED', 'EXPERIMENTAL'].includes(manifest.status)) {
    addError(label + '.status is invalid');
  }

  const relevance = manifest.product_relevance;
  requireObject(relevance, label + '.product_relevance');
  if (isObject(relevance)) {
    exactKeys(relevance, ['relevant', 'reason', 'consumers'], label + '.product_relevance');
    if (typeof relevance.relevant !== 'boolean') addError(label + '.product_relevance.relevant must be boolean');
    requireText(relevance.reason, label + '.product_relevance.reason');
    requireTextArray(relevance.consumers, label + '.product_relevance.consumers', false);
  }

  const origin = manifest.origin;
  requireObject(origin, label + '.origin');
  if (isObject(origin)) {
    exactKeys(origin, ['first_seen', 'generations'], label + '.origin');
    const firstSeen = origin.first_seen;
    requireObject(firstSeen, label + '.origin.first_seen');
    if (isObject(firstSeen)) {
      exactKeys(firstSeen, ['epoch', 'commit', 'date', 'evidence'], label + '.origin.first_seen');
      if (!/^E[0-8]$/.test(firstSeen.epoch || '')) addError(label + '.origin.first_seen.epoch is invalid');
      if (commitExists(firstSeen.commit, label + '.origin.first_seen')) {
        if (!epochCommits.has(firstSeen.commit)) addError(label + '.origin.first_seen.commit is not listed in epochs.yaml');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(firstSeen.date || '')) addError(label + '.origin.first_seen.date must be YYYY-MM-DD');
      requireTextArray(firstSeen.evidence, label + '.origin.first_seen.evidence', false);
    }
    if (!Array.isArray(origin.generations) || origin.generations.length === 0) {
      addError(label + '.origin.generations must be non-empty');
    } else {
      origin.generations.forEach((generation, index) => {
        const generationLabel = label + '.origin.generations[' + index + ']';
        requireObject(generation, generationLabel);
        if (!isObject(generation)) return;
        exactKeys(generation, ['id', 'epoch', 'commit', 'label', 'change'], generationLabel);
        requireText(generation.id, generationLabel + '.id');
        if (!/^E[0-8]$/.test(generation.epoch || '')) addError(generationLabel + '.epoch is invalid');
        if (commitExists(generation.commit, generationLabel)) {
          if (!epochCommits.has(generation.commit)) addError(generationLabel + '.commit is not listed in epochs.yaml');
        }
        requireText(generation.label, generationLabel + '.label');
        requireText(generation.change, generationLabel + '.change');
      });
    }
  }

  for (const section of ['problem', 'authority', 'contracts']) {
    const value = manifest[section];
    requireObject(value, label + '.' + section);
    if (isObject(value)) {
      const keys = section === 'problem'
        ? ['solves', 'does_not_solve']
        : section === 'authority'
          ? ['owns_state', 'owns_completion', 'provides_evidence']
          : ['inputs', 'outputs', 'invariants', 'guardrails'];
      exactKeys(value, keys, label + '.' + section);
      for (const key of keys) requireTextArray(value[key], label + '.' + section + '.' + key, false);
    }
  }
  requireTextArray(manifest.recommended_use, label + '.recommended_use', false);
  requireTextArray(manifest.avoid_use, label + '.avoid_use', false);

  const implementations = manifest.implementations;
  requireObject(implementations, label + '.implementations');
  if (isObject(implementations)) {
    exactKeys(implementations, ['best_known', 'historical'], label + '.implementations');
    for (const [kind, entries] of [['best_known', [implementations.best_known]], ['historical', implementations.historical || []]]) {
      if (!Array.isArray(entries) || (kind === 'historical' && entries.length === 0)) {
        addError(label + '.implementations.' + kind + ' must be present');
        continue;
      }
      entries.forEach((implementation, index) => {
        const implementationLabel = label + '.implementations.' + kind + '[' + index + ']';
        requireObject(implementation, implementationLabel);
        if (!isObject(implementation)) return;
        exactKeys(implementation, ['commit', 'paths', 'generation', 'notes'], implementationLabel);
        if (implementation.commit !== null) {
          commitExists(implementation.commit, implementationLabel);
          if (implementation.commit && implementation.commit.length === 40) {
            for (const implementationPath of implementation.paths || []) pathAtCommit(implementation.commit, implementationPath, implementationLabel);
          }
        }
        requireTextArray(implementation.paths, implementationLabel + '.paths', false);
        (implementation.paths || []).forEach((implementationPath, pathIndex) => safeRelativePath(implementationPath, implementationLabel + '.paths[' + pathIndex + ']'));
        requireText(implementation.generation, implementationLabel + '.generation');
        requireText(implementation.notes, implementationLabel + '.notes');
      });
    }
  }

  const proof = manifest.proof;
  requireObject(proof, label + '.proof');
  if (isObject(proof)) {
    exactKeys(proof, ['tests', 'fixtures', 'smoke'], label + '.proof');
    for (const key of ['tests', 'fixtures', 'smoke']) {
      if (!Array.isArray(proof[key])) addError(label + '.proof.' + key + ' must be an array');
      else proof[key].forEach((item, index) => checkProofItem(item, label + '.proof.' + key + '[' + index + ']', key === 'tests'));
    }
    if (!Array.isArray(proof.tests) || proof.tests.length === 0) addError(label + '.proof.tests must be non-empty');
  }

  if (!Array.isArray(manifest.known_failures) || manifest.known_failures.length === 0) {
    addError(label + '.known_failures must be non-empty');
  } else {
    manifest.known_failures.forEach((failure, index) => {
      const failureLabel = label + '.known_failures[' + index + ']';
      requireObject(failure, failureLabel);
      if (!isObject(failure)) return;
      for (const key of ['id', 'severity', 'symptom', 'root_cause', 'lesson']) requireText(failure[key], failureLabel + '.' + key);
      if (!['P0', 'P1', 'P2', 'P3', 'unknown'].includes(failure.severity)) addError(failureLabel + '.severity is invalid');
      if (failure.fixed_in !== undefined && failure.fixed_in !== null) requireText(failure.fixed_in, failureLabel + '.fixed_in');
      if (failure.regression_tests !== undefined) requireTextArray(failure.regression_tests, failureLabel + '.regression_tests');
    });
  }

  const dependencies = manifest.dependencies;
  requireObject(dependencies, label + '.dependencies');
  if (isObject(dependencies)) {
    exactKeys(dependencies, ['capabilities', 'runtime', 'external'], label + '.dependencies');
    if (!Array.isArray(dependencies.capabilities)) addError(label + '.dependencies.capabilities must be an array');
    else {
      for (const dependency of dependencies.capabilities) {
        if (!allIds.has(dependency)) addError(label + ' depends on missing asset ' + dependency);
        if (dependency === manifest.id) addError(label + ' cannot depend on itself');
      }
    }
    requireTextArray(dependencies.runtime, label + '.dependencies.runtime');
    requireTextArray(dependencies.external, label + '.dependencies.external');
  }

  const integration = manifest.current_integration;
  requireObject(integration, label + '.current_integration');
  if (isObject(integration)) {
    exactKeys(integration, ['layer', 'active', 'notes', 'paths', 'entrypoints'], label + '.current_integration');
    requireText(integration.layer, label + '.current_integration.layer');
    if (typeof integration.active !== 'boolean') addError(label + '.current_integration.active must be boolean');
    requireText(integration.notes, label + '.current_integration.notes');
    requireTextArray(integration.paths, label + '.current_integration.paths', false);
    requireTextArray(integration.entrypoints, label + '.current_integration.entrypoints');
    (integration.paths || []).forEach((integrationPath, index) => {
      safeRelativePath(integrationPath, label + '.current_integration.paths[' + index + ']');
      if (isText(integrationPath) && !currentPathExists(integrationPath)) {
        addError(label + '.current_integration path missing: ' + integrationPath);
      }
    });
    if (manifest.status === 'DEPRECATED' && integration.active !== false) addError(label + ' DEPRECATED asset must be inactive');
  }

  const reintroduction = manifest.reintroduction;
  requireObject(reintroduction, label + '.reintroduction');
  if (isObject(reintroduction)) {
    exactKeys(reintroduction, ['recommended_layer', 'trigger', 'integration_points', 'risks', 'guardrails'], label + '.reintroduction');
    requireText(reintroduction.recommended_layer, label + '.reintroduction.recommended_layer');
    requireText(reintroduction.trigger, label + '.reintroduction.trigger');
    requireTextArray(reintroduction.integration_points, label + '.reintroduction.integration_points', false);
    requireTextArray(reintroduction.risks, label + '.reintroduction.risks', false);
    requireTextArray(reintroduction.guardrails, label + '.reintroduction.guardrails', false);
  }

  const decision = manifest.decision;
  requireObject(decision, label + '.decision');
  if (isObject(decision)) {
    exactKeys(decision, ['disposition', 'rationale', 'follow_up'], label + '.decision');
    if (!['retain', 'reintroduce', 'archive', 'replace', 'forbid', 'unknown'].includes(decision.disposition)) {
      addError(label + '.decision.disposition is invalid');
    }
    requireText(decision.rationale, label + '.decision.rationale');
    requireTextArray(decision.follow_up, label + '.decision.follow_up');
    if (manifest.status === 'DEPRECATED' && !['archive', 'forbid'].includes(decision.disposition)) {
      addError(label + ' DEPRECATED asset must have archive or forbid disposition');
    }
  }

  const subcapabilities = manifest.subcapabilities;
  if (!Array.isArray(subcapabilities) || subcapabilities.length === 0) {
    addError(label + '.subcapabilities must be a non-empty array');
  } else {
    subcapabilities.forEach((subcap, index) => {
      const subcapLabel = label + '.subcapabilities[' + index + ']';
      requireObject(subcap, subcapLabel);
      if (!isObject(subcap)) return;
      exactKeys(subcap, ['id', 'name', 'role', 'disposition', 'product_relevance', 'implementationRefs', 'proofRefs'], subcapLabel);
      requireText(subcap.id, subcapLabel + '.id');
      requireText(subcap.name, subcapLabel + '.name');
      requireText(subcap.role, subcapLabel + '.role');
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subcap.id || '')) {
        addError(subcapLabel + '.id is not kebab-case: ' + subcap.id);
      }
      if (allSubcapabilityIds.has(subcap.id)) {
        addError('duplicate subcapability ID across catalog: ' + subcap.id);
      }
      allSubcapabilityIds.add(subcap.id);
      collectedSubcapabilities.push(subcap);

      if (!['CORE', 'HOST', 'OPTIONAL', 'LIBRARY', 'REFERENCE', 'DEPRECATED', 'EXPERIMENTAL'].includes(subcap.disposition)) {
        addError(subcapLabel + '.disposition is invalid: ' + subcap.disposition);
      }
      requireObject(subcap.product_relevance, subcapLabel + '.product_relevance');
      if (isObject(subcap.product_relevance)) {
        exactKeys(subcap.product_relevance, ['agent_workflow', 'project_knowledge_lifecycle'], subcapLabel + '.product_relevance');
        if (typeof subcap.product_relevance.agent_workflow !== 'boolean') addError(subcapLabel + '.product_relevance.agent_workflow must be boolean');
        if (typeof subcap.product_relevance.project_knowledge_lifecycle !== 'boolean') addError(subcapLabel + '.product_relevance.project_knowledge_lifecycle must be boolean');
      }
      if (subcap.disposition === 'CORE') {
        if (!subcap.product_relevance?.agent_workflow && !subcap.product_relevance?.project_knowledge_lifecycle) {
          addError(subcapLabel + ' CORE subcapability must be relevant to agent_workflow or project_knowledge_lifecycle');
        }
      }

      if (!Array.isArray(subcap.implementationRefs) || subcap.implementationRefs.length === 0) {
        addError(subcapLabel + '.implementationRefs must be a non-empty array');
      } else {
        subcap.implementationRefs.forEach((ref, refIndex) => {
          const refLabel = subcapLabel + '.implementationRefs[' + refIndex + ']';
          requireObject(ref, refLabel);
          if (!isObject(ref)) return;
          exactKeys(ref, ['path', 'commit'], refLabel);
          requireText(ref.path, refLabel + '.path');
          safeRelativePath(ref.path, refLabel + '.path');
          if (ref.commit !== null && ref.commit !== undefined) {
            commitExists(ref.commit, refLabel + '.commit');
            if (ref.commit && ref.commit.length === 40) {
              pathAtCommit(ref.commit, ref.path, refLabel);
            }
          } else {
            if (isText(ref.path) && !currentPathExists(ref.path)) {
              addError(refLabel + ' path does not exist in current checkout: ' + ref.path);
            }
          }
        });
      }

      if (!Array.isArray(subcap.proofRefs) || subcap.proofRefs.length === 0) {
        addError(subcapLabel + '.proofRefs must be a non-empty array');
      } else {
        const manifestTestIds = new Set((manifest.proof?.tests || []).map((t) => t.id));
        subcap.proofRefs.forEach((pr, prIndex) => {
          const prLabel = subcapLabel + '.proofRefs[' + prIndex + ']';
          requireText(pr, prLabel);
          if (!manifestTestIds.has(pr)) {
            addError(prLabel + ' (' + pr + ') does not match any proof.tests id in ' + manifest.id);
          }
        });
      }
    });
  }
}

const schema = readJson(schemaPath, 'asset.schema.json') || {};
const catalog = readJson(catalogPath, 'catalog.yaml') || {};
const taxonomy = readText(taxonomyPath, 'taxonomy.yaml');
const epochs = readText(epochsPath, 'epochs.yaml');
const inventory = readText(inventoryPath, 'inventory-current.yaml');

if (!taxonomy.includes('schemaVersion: 1')) addError('taxonomy.yaml must declare schemaVersion 1');
for (const domain of ['WORK', 'TRUST', 'KNOWLEDGE', 'EXECUTION', 'INTELLIGENCE', 'OPTIMIZATION', 'PRODUCTIVITY']) {
  if (!taxonomy.includes(domain + ':')) addError('taxonomy.yaml is missing domain ' + domain);
}
for (const status of ['CORE', 'HOST', 'OPTIONAL', 'LIBRARY', 'REFERENCE', 'DEPRECATED', 'EXPERIMENTAL']) {
  if (!taxonomy.includes(status + ':')) addError('taxonomy.yaml is missing status ' + status);
}

const epochCommits = new Set((epochs.match(/[0-9a-f]{40}/g) || []));
if (!epochCommits.has('9701a86d2225c938f13982a7e0f7f43a7f9bc10e')) addError('epochs.yaml is missing the baseline commit');
for (const commit of epochCommits) commitExists(commit, 'epochs.yaml');

const manifestDir = path.join(assetRoot, 'capabilities');
const manifestPaths = fs.existsSync(manifestDir)
  ? fs.readdirSync(manifestDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(manifestDir, entry.name, 'asset.yaml'))
    .filter(fs.existsSync)
    .sort()
  : [];
const manifests = [];
const allIds = new Set();
const allSubcapabilityIds = new Set();
const collectedSubcapabilities = [];
for (const manifestPath of manifestPaths) {
  const manifest = readJson(manifestPath, manifestPath.replace(root + path.sep, '').replaceAll(path.sep, '/'));
  if (manifest?.id) allIds.add(manifest.id);
  manifests.push({ path: manifestPath, data: manifest });
}
for (const record of manifests) checkManifest(record.data, record.path, schema, epochCommits, allIds, allSubcapabilityIds, collectedSubcapabilities);
if (allIds.size !== manifestPaths.length) addError('capability manifest IDs must be unique');

const coverageLedger = readJson(coverageLedgerPath, 'coverage-ledger.yaml');
if (!isObject(coverageLedger)) {
  addError('coverage-ledger.yaml must be JSON-compatible YAML');
} else {
  if (coverageLedger.schemaVersion !== 1 || coverageLedger.kind !== 'capability-asset-coverage-ledger') {
    addError('coverage-ledger.yaml metadata is invalid');
  }
  if (coverageLedger.summary?.unclassifiedCount !== 0) {
    addError('coverage-ledger.yaml unclassifiedCount must be 0, found ' + coverageLedger.summary?.unclassifiedCount);
  }
  const surfaces = coverageLedger.surfaces || {};
  const currentSurfaces = sourceMigration?.surfaces || {};
  if (sourceMigration?.schemaVersion !== 1 || sourceMigration?.kind !== 'typed-capability-surface-migrations'
      || sourceMigration.baselineCommit !== coverageLedger.baselineCommit) {
    addError('typed capability migration catalog must match the frozen baseline');
  }
  for (const [filePath, entry] of Object.entries(currentSurfaces)) {
    safeRelativePath(filePath, 'typed capability surface ' + filePath);
    if (!fs.existsSync(path.join(root, filePath))) addError('typed capability surface missing: ' + filePath);
    if (entry.classification === 'capability' && !allIds.has(entry.capability)) addError('typed capability surface has unknown capability: ' + filePath);
    if (!['capability', 'ignored'].includes(entry.classification)) addError('typed capability surface must be classified: ' + filePath);
    if (entry.classification === 'ignored' && !isText(entry.reason)) addError('ignored typed capability surface requires a reason: ' + filePath);
  }
  for (const item of runtimeFiles.values()) {
    for (const [filePath, digest] of [[item.source, item.sourceDigest], [item.output, item.outputDigest]]) {
      if (!surfaces[filePath] && !currentSurfaces[filePath]) addError('typed runtime surface is not classified: ' + filePath);
      if (!fs.existsSync(path.join(root, filePath)) || createHash('sha256').update(fs.readFileSync(path.join(root, filePath), 'utf8').replace(/\r\n/g, '\n')).digest('hex') !== digest) {
        addError('typed runtime surface is missing or stale: ' + filePath);
      }
    }
  }
  const baselineTree = git(['ls-tree', '-r', '--name-only', coverageLedger.baselineCommit]);
  const historicalPaths = new Set(baselineTree.status === 0 ? baselineTree.stdout.split(/\r?\n/).filter(Boolean) : []);
  for (const [oldPath, migration] of Object.entries(sourceMigration?.migrations || {})) {
    safeRelativePath(oldPath, 'typed migration original path');
    if (!surfaces[oldPath]) addError('typed migration original path is not in the frozen ledger: ' + oldPath);
    if (migration.retired === true) {
      if (!isText(migration.reason) || !historicalPaths.has(oldPath)) addError('retired surface lacks historical evidence: ' + oldPath);
    } else {
      safeRelativePath(migration.source, 'typed migration source');
      safeRelativePath(migration.output, 'typed migration output');
      if (!currentPathExists(oldPath)) addError('typed migration does not resolve to a current compiler-owned surface: ' + oldPath);
    }
  }
  const surfaceEntries = Object.entries(surfaces);
  if (surfaceEntries.length !== coverageLedger.summary?.totalMapped) {
    addError('coverage-ledger.yaml totalMapped mismatch: summary says ' + coverageLedger.summary?.totalMapped + ', found ' + surfaceEntries.length);
  }
  let classifiedCount = 0;
  let ignoredCount = 0;
  for (const [filePath, entry] of surfaceEntries) {
    safeRelativePath(filePath, 'coverage-ledger surface ' + filePath);
    if (!currentPathExists(filePath) && !(sourceMigration?.migrations?.[filePath]?.retired === true && historicalPaths.has(filePath))) {
      addError('coverage-ledger surface file does not exist: ' + filePath);
    }
    if (entry.classification === 'capability') {
      classifiedCount++;
      if (!allIds.has(entry.capability)) {
        addError('coverage-ledger surface ' + filePath + ' references unknown capability: ' + entry.capability);
      }
    } else if (entry.classification === 'ignored') {
      ignoredCount++;
      requireText(entry.reason, 'coverage-ledger ignored surface ' + filePath + '.reason');
      const validReasons = ['generic-development-skill', 'external-domain-skill', 'provider-specific-helper'];
      if (!validReasons.includes(entry.reason)) {
        addError('coverage-ledger ignored surface ' + filePath + ' has invalid reason: ' + entry.reason);
      }
    } else {
      addError('coverage-ledger surface ' + filePath + ' has unknown classification: ' + entry.classification);
    }
  }
  if (classifiedCount !== coverageLedger.summary?.classifiedCapabilityCount) {
    addError('coverage-ledger classifiedCapabilityCount mismatch');
  }
  if (ignoredCount !== coverageLedger.summary?.ignoredCount) {
    addError('coverage-ledger ignoredCount mismatch');
  }

  const gitFilesResult = git(['ls-files']);
  const deletedFilesResult = git(['ls-files', '--deleted']);
  if (gitFilesResult.status === 0) {
    const gitFiles = gitFilesResult.stdout.split(/\r?\n/).filter(Boolean);
    const deletedFiles = new Set(deletedFilesResult.status === 0 ? deletedFilesResult.stdout.split(/\r?\n/).filter(Boolean) : []);
    const corePrefixes = ['scripts/kernel/', 'kernel/', 'package/kernel/', 'archive/scripts/legacy-phase-adapters/'];
    for (const gf of gitFiles) {
      const isCore = corePrefixes.some((prefix) => gf.startsWith(prefix))
        || (gf.startsWith('schemas/kernel.') && gf.endsWith('.json'))
        || (gf.startsWith('tests/kernel-') && gf.endsWith('.test.mjs'))
        || gf === 'bin/moon-relay-kernel.mjs'
        || gf === 'bin/moonshot-relay.mjs'
        || gf === 'bin/moon-relay-standalone.mjs';
      if (isCore && !surfaces[gf] && !currentSurfaces[gf] && !deletedFiles.has(gf)) {
        addError('core file not mapped in coverage-ledger.yaml: ' + gf);
      }
    }
  }

  const skillsDir = path.join(root, 'skills');
  if (fs.existsSync(skillsDir)) {
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const knownRelayKernelSkills = new Set([
      'moon-relay-kernel', 'kernel-commit', 'kernel-commit-closeout',
      'kernel-verification-before-completion', 'kernel-browser-proof-adapter',
      'kernel-security-review-policy', 'kernel-review-standards', 'kernel-review-complexity',
      'kernel-review-spec', 'kernel-simplification-check', 'kernel-diagnosing-bugs',
      'kernel-test-driven-development', 'kernel-tracer-slicing', 'kernel-domain-modeling',
      'kernel-conditional-frontend-guidance', 'kernel-minimal-correct-change',
      'moonshot-architecture', 'architecture-artifacts', 'codebase-understanding',
      'explain-diff-html', 'ui-audit', 'product-definition', 'moonshot-retro',
      'session-logger', 'project-memory', 'project-memory-refresh', 'harness-memory-promoter',
      'moonshot-phase-runner', 'moonshot-phase-executor', 'moonshot-orchestrator',
      'implementation-runner', 'task-slicer', 'codex-validate-plan', 'pre-flight-check',
      'project-contract-gate', 'karpathy-execution-gate', 'moonshot-plan-writer',
      'moonshot-classify-task', 'moonshot-decide-sequence', 'moonshot-detect-uncertainty',
      'moonshot-evaluate-complexity', 'completion-verifier', 'browser-verifier',
      'failure-analyzer', 'plan-ceo-review', 'plan-eng-review', 'verification-contract-gate',
      'verification-evidence-gate', 'commit-moonshot', 'moonshot-in-session-coordinator',
      'moonshot-teams-runner', 'workspace-isolation-gate', 'moonshot-relay-maintainer',
      'moonshot-relay-setup', 'product-orchestrator', 'product-gate-reviewer', 'project-md-refresh'
    ]);

    const isRelayKernelSkill = (name) => (
      name.startsWith('moon-') ||
      name.startsWith('moonshot-') ||
      name.startsWith('kernel-') ||
      name.startsWith('completion-') ||
      name.startsWith('verification-') ||
      name.startsWith('project-') ||
      name.startsWith('plan-') ||
      knownRelayKernelSkills.has(name)
    );

    for (const skillName of skillEntries) {
      const skillFile = 'skills/' + skillName + '/SKILL.md';
      if (fs.existsSync(path.join(root, skillFile))) {
        if (!surfaces[skillFile]) {
          addError('skill directory not registered in coverage-ledger.yaml: ' + skillFile);
        } else if (isRelayKernelSkill(skillName)) {
          if (surfaces[skillFile].classification === 'ignored') {
            addError('known or pattern-matched Relay/Kernel workflow skill must not be ignored: ' + skillFile);
          }
        }
      }
    }
  }
}

if (!isObject(catalog)) {
  addError('catalog.yaml must be JSON-compatible YAML');
} else {
  if (catalog.schemaVersion !== 1 || catalog.kind !== 'capability-asset-catalog') addError('catalog metadata is invalid');
  if (catalog.catalogVersion !== 4) addError('catalog.catalogVersion must be 4');
  if (String(catalog.baselineVersion) !== '2.1') addError('catalog.baselineVersion must be 2.1');
  if (!Array.isArray(catalog.assets)) addError('catalog.assets must be an array');
  const catalogIds = new Set((catalog.assets || []).map((asset) => asset.id));
  if (catalog.assetCount !== (catalog.assets || []).length) addError('catalog.assetCount does not match catalog.assets');
  if (catalogIds.size !== (catalog.assets || []).length) addError('catalog asset IDs must be unique');
  if (catalogIds.size !== allIds.size || [...allIds].some((id) => !catalogIds.has(id))) addError('catalog and manifest ID sets differ');
  for (const asset of catalog.assets || []) {
    if (!allIds.has(asset.id)) continue;
    const manifestRecord = manifests.find((record) => record.data?.id === asset.id);
    if (!manifestRecord) continue;
    const expectedPath = path.relative(assetRoot, manifestRecord.path).replaceAll(path.sep, '/');
    if (asset.path !== expectedPath) addError('catalog path mismatch for ' + asset.id);
    if (asset.domain !== manifestRecord.data.category) addError('catalog domain mismatch for ' + asset.id);
    if (asset.status !== manifestRecord.data.status) addError('catalog status mismatch for ' + asset.id);
    for (const key of ['agent_workflow', 'project_knowledge_lifecycle']) {
      if (asset.relevance?.[key] !== manifestRecord.data.product_relevance?.relevant && key === 'agent_workflow') {
        warnings.push('catalog relevance is intentionally more granular than manifest relevance for ' + asset.id);
      }
    }
  }
  const computedCounts = {};
  for (const asset of catalog.assets || []) computedCounts[asset.status] = (computedCounts[asset.status] || 0) + 1;
  for (const status of catalog.classification?.statuses || []) {
    if ((catalog.classification?.counts?.[status] || 0) !== (computedCounts[status] || 0)) {
      addError('catalog classification count mismatch for ' + status);
    }
  }

  const subcapCounts = {};
  for (const sc of collectedSubcapabilities) {
    subcapCounts[sc.disposition] = (subcapCounts[sc.disposition] || 0) + 1;
  }
  if (catalog.classification?.subcapabilityCounts?.total !== collectedSubcapabilities.length) {
    addError('catalog.classification.subcapabilityCounts.total mismatch: expected ' + collectedSubcapabilities.length + ', got ' + catalog.classification?.subcapabilityCounts?.total);
  }
  for (const [status, count] of Object.entries(catalog.classification?.subcapabilityCounts || {})) {
    if (status === 'total') continue;
    if ((subcapCounts[status] || 0) !== count) {
      addError('catalog.classification.subcapabilityCounts.' + status + ' mismatch: expected ' + (subcapCounts[status] || 0) + ', got ' + count);
    }
  }

  const trace = catalog.classification?.traceabilitySummary;
  if (!trace || trace.totalSubcapabilities !== collectedSubcapabilities.length || trace.withImplementationTrace !== collectedSubcapabilities.length || trace.withProofTrace !== collectedSubcapabilities.length || trace.traceabilityPct !== 100) {
    addError('catalog traceabilitySummary is incomplete or mismatched');
  }

  if (catalog.freeze?.coverageSummary) {
    if (catalog.freeze.coverageSummary.unclassifiedCount !== 0) {
      addError('catalog.freeze.coverageSummary.unclassifiedCount must be 0');
    }
    if (catalog.freeze.coverageSummary.totalMapped !== coverageLedger?.summary?.totalMapped) {
      addError('catalog.freeze.coverageSummary.totalMapped mismatch with coverage-ledger');
    }
    if (catalog.freeze.coverageSummary.classifiedCapabilityCount !== coverageLedger?.summary?.classifiedCapabilityCount) {
      addError('catalog.freeze.coverageSummary.classifiedCapabilityCount mismatch with coverage-ledger');
    }
    if (catalog.freeze.coverageSummary.ignoredCount !== coverageLedger?.summary?.ignoredCount) {
      addError('catalog.freeze.coverageSummary.ignoredCount mismatch with coverage-ledger');
    }
  }

  if (catalog.scope?.runtimeLoaded !== false || catalog.scope?.installerLoaded !== false || catalog.scope?.productionBehaviorChanged !== false || catalog.scope?.decomplexificationPerformed !== false || catalog.scope?.sourceSnapshotsCopied !== false) {
    addError('catalog scope boundary must remain non-runtime and non-decomplexification');
  }
  if (catalog.freeze?.baselineStatus !== 'frozen' || catalog.freeze?.decomplexification !== 'not performed; separately authorized work required') {
    addError('catalog freeze boundary is incomplete');
  }
}

if (!inventory.includes('finalClassification: complete')) addError('inventory-current.yaml finalClassification is not complete');
if (!inventory.includes('perCapabilityManifests: complete')) addError('inventory-current.yaml must record complete manifests');
if (!inventory.includes('relayHistory: complete')) addError('inventory-current.yaml relayHistory is not complete');
if (!inventory.includes('kernelHistory: complete')) addError('inventory-current.yaml kernelHistory is not complete');

const decomplexMapsPath = path.join(assetRoot, 'decisions', 'decomplexification-maps.md');
if (!fs.existsSync(decomplexMapsPath)) {
  addError('decomplexification-maps.md missing at docs/capability-assets/decisions/decomplexification-maps.md');
} else {
  const mapContent = readText(decomplexMapsPath, 'decomplexification-maps.md');
  const sections = [
    { title: '## 1. CORE MAP', disposition: 'CORE' },
    { title: '## 2. HOST MAP', disposition: 'HOST' },
    { title: '## 3. OPTIONAL MAP', disposition: 'OPTIONAL' },
    { title: '## 4. REFERENCE MAP', disposition: 'REFERENCE' },
    { title: '## 5. DEPRECATED MAP', disposition: 'DEPRECATED' },
  ];
  const subcapDispositionMap = new Map();
  for (const sc of collectedSubcapabilities) {
    subcapDispositionMap.set(sc.id, sc.disposition);
  }
  const seenInMap = new Set();
  for (let i = 0; i < sections.length; i++) {
    const startIdx = mapContent.indexOf(sections[i].title);
    if (startIdx === -1) {
      addError('decomplexification-maps.md missing section header: ' + sections[i].title);
      continue;
    }
    const endIdx = i + 1 < sections.length ? mapContent.indexOf(sections[i + 1].title, startIdx) : mapContent.length;
    const sectionText = mapContent.substring(startIdx, endIdx);
    const idMatches = [...sectionText.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|/g)].map((m) => m[1]);
    for (const id of idMatches) {
      if (seenInMap.has(id)) {
        addError('decomplexification-maps.md contains duplicate subcapability ID: ' + id);
      }
      seenInMap.add(id);
      const actualDisp = subcapDispositionMap.get(id);
      if (!actualDisp) {
        addError('decomplexification-maps.md references unknown subcapability ID: ' + id);
      } else if (actualDisp !== sections[i].disposition) {
        addError('decomplexification-maps.md disposition mismatch for ' + id + ': expected ' + sections[i].disposition + ', manifest has ' + actualDisp);
      }
    }
  }
  if (seenInMap.size !== collectedSubcapabilities.length) {
    addError('decomplexification-maps.md subcapability count mismatch: expected ' + collectedSubcapabilities.length + ', found ' + seenInMap.size);
  }
}

if (fs.existsSync(baselineDocPath)) {
  const baselineContent = readText(baselineDocPath, 'CAPABILITY_ASSET_BASELINE.md');
  const tierConfigs = [
    { pattern: /Tier 1\s*\([^)]*Core[^)]*\)/i, disposition: 'CORE' },
    { pattern: /Tier 2\s*\([^)]*Host[^)]*\)/i, disposition: 'HOST' },
    { pattern: /Tier 3\s*\([^)]*Optional[^)]*\)/i, disposition: 'OPTIONAL' },
    { pattern: /Tier 4\s*\([^)]*Reference[^)]*\)/i, disposition: 'REFERENCE' },
    { pattern: /Tier 5\s*\([^)]*Deprecated[^)]*\)/i, disposition: 'DEPRECATED' },
  ];
  const subcapDispositionMap = new Map();
  for (const sc of collectedSubcapabilities) {
    subcapDispositionMap.set(sc.id, sc.disposition);
  }
  const lines = baselineContent.split(/\r?\n/);
  const tierIndices = tierConfigs.map((tc) => lines.findIndex((l) => tc.pattern.test(l)));
  let totalBaselineTierSubcaps = 0;
  for (let i = 0; i < tierConfigs.length; i++) {
    const startIdx = tierIndices[i];
    if (startIdx === -1) continue;
    let endIdx = lines.length;
    for (let j = i + 1; j < tierConfigs.length; j++) {
      if (tierIndices[j] !== -1) {
        endIdx = tierIndices[j];
        break;
      }
    }
    const chunk = lines.slice(startIdx, endIdx).join('\n');
    const matches = [...chunk.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    const subcapMatches = matches.filter((id) => allSubcapabilityIds.has(id));
    for (const id of subcapMatches) {
      totalBaselineTierSubcaps++;
      const actualDisp = subcapDispositionMap.get(id);
      if (actualDisp !== tierConfigs[i].disposition) {
        addError('CAPABILITY_ASSET_BASELINE.md tier disposition mismatch for ' + id + ': placed under ' + tierConfigs[i].disposition + ', manifest has ' + actualDisp);
      }
    }
  }
  if (totalBaselineTierSubcaps > 0 && totalBaselineTierSubcaps !== collectedSubcapabilities.length) {
    addError('CAPABILITY_ASSET_BASELINE.md tier subcapability count mismatch: expected ' + collectedSubcapabilities.length + ', found ' + totalBaselineTierSubcaps);
  }
}

const result = {
  schemaVersion: 1,
  catalogVersion: catalog?.catalogVersion || 1,
  baselineVersion: catalog?.baselineVersion || 1,
  status: errors.length === 0 ? 'pass' : 'fail',
  readOnly: true,
  baselineCommit: '9701a86d2225c938f13982a7e0f7f43a7f9bc10e',
  assetCount: manifests.length,
  subcapabilityCount: collectedSubcapabilities.length,
  statusCounts: manifests.reduce((counts, record) => {
    const status = record.data?.status || 'invalid';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {}),
  subcapabilityStatusCounts: collectedSubcapabilities.reduce((counts, sc) => {
    counts[sc.disposition] = (counts[sc.disposition] || 0) + 1;
    return counts;
  }, {}),
  traceabilitySummary: {
    totalSubcapabilities: collectedSubcapabilities.length,
    withImplementationTrace: collectedSubcapabilities.filter((s) => s.implementationRefs?.length > 0).length,
    withProofTrace: collectedSubcapabilities.filter((s) => s.proofRefs?.length > 0).length,
    traceabilityPct: 100
  },
  checked: {
    manifestSchema: fs.existsSync(schemaPath),
    catalog: fs.existsSync(catalogPath),
    taxonomy: fs.existsSync(taxonomyPath),
    epochs: fs.existsSync(epochsPath),
    inventory: fs.existsSync(inventoryPath),
    coverageLedger: fs.existsSync(coverageLedgerPath),
    rootBaselineForbidden: !fs.existsSync(rootBaselineDocPath),
    canonicalBaselineExists: fs.existsSync(baselineDocPath),
    immutableCommits: epochCommits.size,
    proofPaths: manifests.reduce((count, record) => count + (record.data?.proof?.tests?.length || 0), 0),
    dependencies: manifests.reduce((count, record) => count + (record.data?.dependencies?.capabilities?.length || 0), 0),
    subcapabilities: collectedSubcapabilities.length,
    subcapabilitiesTraced: collectedSubcapabilities.every((s) => s.implementationRefs?.length > 0 && s.proofRefs?.length > 0),
    coverageSurfaces: Object.keys(coverageLedger?.surfaces || {}).length,
    decomplexificationMaps: fs.existsSync(decomplexMapsPath),
    baselineTierConsistency: true,
  },
  warnings,
  errors
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = errors.length === 0 ? 0 : 1;
