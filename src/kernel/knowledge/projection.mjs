import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { projectKnowledgeDirectory } from './store.mjs';

function itemsContent(items) {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}

export async function rebuildKnowledgeProjection(projectId, { stateStore = null, runtimeHome = resolveKernelRuntimeHome(), env = process.env } = {}) {
  if (!stateStore) return { status: 'skipped' };

  const projectKnowledgeDir = path.join(projectKnowledgeDirectory(projectId, { env: { ...env, MOON_RELAY_KERNEL_HOME: runtimeHome } }), 'knowledge');
  const genId = `gen-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tempGenDir = path.join(projectKnowledgeDir, '.projection', genId);

  await mkdir(tempGenDir, { recursive: true });

  const records = stateStore.listKnowledgeRecords({ projectId, statuses: ['committed', 'verified'] });
  const revision = stateStore.getProjectKnowledgeRevision ? stateStore.getProjectKnowledgeRevision(projectId) : 0;

  const buckets = {
    'policy/anchors.jsonl': [],
    'semantic/facts.jsonl': [],
    'architecture/decisions.jsonl': [],
    'domain/terms.jsonl': [],
    'architecture/components.jsonl': [],
    'architecture/api-contracts.jsonl': [],
    'graph/relations.jsonl': [],
    'ontology/constraints.jsonl': [],
    'episodic/observations.jsonl': [],
    'tacit/practices.jsonl': [],
    'failures/patterns.jsonl': [],
    'verification/required.jsonl': [],
    'provenance/events.jsonl': [],
    'facts.jsonl': [],
    'practices.jsonl': [],
    'constraints.jsonl': [],
    'failures.jsonl': [],
  };

  for (const rec of records) {
    const raw = rec.recordJson || rec;
    const type = rec.type || rec.recordType;

    if (type === 'policy_anchor') buckets['policy/anchors.jsonl'].push(raw);
    else if (type === 'semantic_fact') {
      buckets['semantic/facts.jsonl'].push(raw);
      buckets['facts.jsonl'].push(raw);
    } else if (type === 'architecture_decision') buckets['architecture/decisions.jsonl'].push(raw);
    else if (type === 'domain_term') buckets['domain/terms.jsonl'].push(raw);
    else if (type === 'component_boundary') buckets['architecture/components.jsonl'].push(raw);
    else if (type === 'api_contract') buckets['architecture/api-contracts.jsonl'].push(raw);
    else if (type === 'kg_relation') buckets['graph/relations.jsonl'].push(raw);
    else if (type === 'ontology_constraint') {
      buckets['ontology/constraints.jsonl'].push(raw);
      buckets['constraints.jsonl'].push(raw);
    } else if (type === 'episodic_observation') {
      buckets['episodic/observations.jsonl'].push(raw);
      buckets['practices.jsonl'].push(raw);
    } else if (type === 'tacit_practice') {
      buckets['tacit/practices.jsonl'].push(raw);
      buckets['practices.jsonl'].push(raw);
    } else if (type === 'known_failure_pattern' || type === 'failure_pattern') {
      buckets['failures/patterns.jsonl'].push(raw);
      buckets['failures.jsonl'].push(raw);
    } else if (type === 'required_verification') buckets['verification/required.jsonl'].push(raw);
    else if (type === 'provenance_event') buckets['provenance/events.jsonl'].push(raw);
  }

  for (const [relPath, items] of Object.entries(buckets)) {
    const targetFile = path.join(tempGenDir, relPath);
    await mkdir(path.dirname(targetFile), { recursive: true });
    const content = itemsContent(items);
    await writeFile(targetFile, content, 'utf8');
  }

  const manifest = {
    schemaVersion: 1,
    generationId: genId,
    projectId,
    knowledgeRevision: revision,
    recordCount: records.length,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(tempGenDir, 'revision.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Copy files to target project knowledge dir
  for (const [relPath] of Object.entries(buckets)) {
    const dest = path.join(projectKnowledgeDir, relPath);
    await mkdir(path.dirname(dest), { recursive: true });
    const fileContent = itemsContent(buckets[relPath]);
    await writeFile(dest, fileContent, 'utf8');
  }
  await writeFile(path.join(projectKnowledgeDir, 'revision.json'), JSON.stringify(manifest, null, 2), 'utf8');

  try {
    await rm(path.join(projectKnowledgeDir, '.projection'), { recursive: true, force: true });
  } catch (_) {}

  return {
    status: 'rebuilt',
    projectId,
    revision,
    count: records.length,
    projectDir: projectKnowledgeDir,
  };
}
