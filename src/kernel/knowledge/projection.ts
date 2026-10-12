import path from 'node:path';
import { resolveKernelRuntimeHome } from '../runtime-home.js';
import {
  projectKnowledgeDirectory,
  writeAtomicJson,
  writeAtomicJsonl,
} from './store.js';

type UnknownRecord = Record<string, unknown>;
type ProjectionBucket = unknown[];
type ProjectionBuckets = Record<string, ProjectionBucket>;

export interface KnowledgeProjectionRecord extends UnknownRecord {
  recordJson?: unknown;
  type?: unknown;
  recordType?: unknown;
}

export interface KnowledgeProjectionStore {
  listKnowledgeRecords(input: {
    projectId: string;
    statuses: string[];
  }): KnowledgeProjectionRecord[];
  getProjectKnowledgeRevision(projectId: string): unknown;
}

export interface RebuildKnowledgeProjectionOptions {
  stateStore?: KnowledgeProjectionStore | null;
  runtimeHome?: string | null;
  env?: NodeJS.ProcessEnv;
  revisionAfter?: unknown;
}

export type KnowledgeProjectionResult =
  | {
      status: 'rebuilt';
      projectId: string;
      revision: unknown;
      count: number;
      projectDir: string;
    }
  | {
      status: 'failed';
      reason: 'state_store_required';
    }
  | {
      status: 'failed';
      error: string;
    };

const push = (
  buckets: ProjectionBuckets,
  key: string,
  value: unknown,
): void => {
  const bucket = buckets[key];
  if (!bucket) throw new Error('Unknown knowledge projection bucket: ' + key);
  bucket.push(value);
};

export async function rebuildKnowledgeProjection(
  projectId: string,
  {
    stateStore = null,
    runtimeHome = null,
    env = process.env,
    revisionAfter = null,
  }: RebuildKnowledgeProjectionOptions = {},
): Promise<KnowledgeProjectionResult> {
  if (!stateStore) {
    return { status: 'failed', reason: 'state_store_required' };
  }

  try {
    const effectiveRuntimeHome = runtimeHome
      || resolveKernelRuntimeHome({ env });
    const projectKnowledgeDir = path.join(
      projectKnowledgeDirectory(projectId, {
        env: {
          ...env,
          MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome,
        },
      }),
      'knowledge',
    );
    const records = stateStore.listKnowledgeRecords({
      projectId,
      statuses: ['committed', 'verified'],
    });
    const revision = revisionAfter !== null && revisionAfter !== undefined
      ? revisionAfter
      : stateStore.getProjectKnowledgeRevision(projectId);

    const buckets: ProjectionBuckets = {
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

    for (const record of records) {
      const raw = record.recordJson || record;
      const type = String(record.type || record.recordType || '');
      if (type === 'policy_anchor') {
        push(buckets, 'policy/anchors.jsonl', raw);
      } else if (type === 'semantic_fact') {
        push(buckets, 'semantic/facts.jsonl', raw);
        push(buckets, 'facts.jsonl', raw);
      } else if (type === 'architecture_decision') {
        push(buckets, 'architecture/decisions.jsonl', raw);
      } else if (type === 'domain_term') {
        push(buckets, 'domain/terms.jsonl', raw);
      } else if (type === 'component_boundary') {
        push(buckets, 'architecture/components.jsonl', raw);
      } else if (type === 'api_contract') {
        push(buckets, 'architecture/api-contracts.jsonl', raw);
      } else if (type === 'kg_relation') {
        push(buckets, 'graph/relations.jsonl', raw);
      } else if (type === 'ontology_constraint') {
        push(buckets, 'ontology/constraints.jsonl', raw);
        push(buckets, 'constraints.jsonl', raw);
      } else if (type === 'episodic_observation') {
        push(buckets, 'episodic/observations.jsonl', raw);
        push(buckets, 'practices.jsonl', raw);
      } else if (type === 'tacit_practice') {
        push(buckets, 'tacit/practices.jsonl', raw);
        push(buckets, 'practices.jsonl', raw);
      } else if (
        type === 'known_failure_pattern'
        || type === 'failure_pattern'
      ) {
        push(buckets, 'failures/patterns.jsonl', raw);
        push(buckets, 'failures.jsonl', raw);
      } else if (type === 'required_verification') {
        push(buckets, 'verification/required.jsonl', raw);
      } else if (type === 'provenance_event') {
        push(buckets, 'provenance/events.jsonl', raw);
      }
    }

    // Legacy names remain derived outputs only. They are written from the same
    // SQLite records and are never read as canonical Knowledge authority.
    const legacyBuckets: ProjectionBuckets = {
      'semantic/verified-facts.jsonl': [
        ...(buckets['policy/anchors.jsonl'] ?? []),
        ...(buckets['semantic/facts.jsonl'] ?? []),
      ],
      'architecture/records.jsonl': [
        ...(buckets['architecture/decisions.jsonl'] ?? []),
        ...(buckets['domain/terms.jsonl'] ?? []),
        ...(buckets['architecture/components.jsonl'] ?? []),
        ...(buckets['architecture/api-contracts.jsonl'] ?? []),
        ...(buckets['failures/patterns.jsonl'] ?? []),
        ...(buckets['verification/required.jsonl'] ?? []),
      ],
      'graph/kg-relations.jsonl': [
        ...(buckets['graph/relations.jsonl'] ?? []),
      ],
    };

    for (const [relativePath, items] of Object.entries({
      ...buckets,
      ...legacyBuckets,
    })) {
      await writeAtomicJsonl(
        path.join(projectKnowledgeDir, relativePath),
        items,
      );
    }

    const manifest = {
      schemaVersion: 1,
      projectId,
      revision: String(revision),
      knowledgeRevision: revision,
      recordCount: records.length,
      updatedAt: new Date().toISOString(),
    };
    await writeAtomicJson(
      path.join(projectKnowledgeDir, 'revision.json'),
      manifest,
    );

    return {
      status: 'rebuilt',
      projectId,
      revision,
      count: records.length,
      projectDir: projectKnowledgeDir,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
