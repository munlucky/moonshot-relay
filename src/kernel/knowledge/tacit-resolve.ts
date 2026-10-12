import { requiredIndex } from '../../shared/required-index.js';
interface ObservationLike {
  type?: string | null;
  recordType?: string | null;
  statement: string;
  runId?: string | null;
  status?: string | null;
  evidence?: unknown;
  [key: string]: unknown;
}

interface KnowledgeRecordReader {
  listKnowledgeRecords(input?: {
    projectId?: string | null;
    statuses?: string[];
  }): ObservationLike[];
}

export interface ResolveTacitPracticesInput {
  projectId: string;
  stateStore?: KnowledgeRecordReader | null;
  records?: ObservationLike[] | null;
}

export async function resolveTacitPractices({
  projectId,
  stateStore = null,
  records = null,
}: ResolveTacitPracticesInput) {
  const sourceRecords = stateStore
    ? stateStore.listKnowledgeRecords({
        projectId,
        statuses: ['verified', 'committed', 'observed'],
      })
    : Array.isArray(records)
      ? records
      : null;
  if (!sourceRecords) {
    throw Object.assign(
      new Error('SQLite Knowledge authority or explicit records are required'),
      { code: 'KNOWLEDGE_AUTHORITY_REQUIRED' },
    );
  }

  const observations = sourceRecords.filter((record) => (
    String(record.type || record.recordType || '') === 'episodic_observation'
  ));

  const groups = new Map<string, ObservationLike[]>();
  for (const observation of observations) {
    const key = observation.statement.trim().toLowerCase();
    const entries = groups.get(key) || [];
    entries.push(observation);
    groups.set(key, entries);
  }

  const tacitPractices: Array<{
    id: string;
    statement: string;
    confidence: number;
    observedRuns: string[];
  }> = [];

  for (const observationsForStatement of groups.values()) {
    const distinctRuns = new Set(
      observationsForStatement
        .map((observation) => observation.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    const hasVerification = observationsForStatement.some((observation) => (
      observation.status === 'verified' || Boolean(observation.evidence)
    ));

    if (distinctRuns.size >= 2 && hasVerification) {
      tacitPractices.push({
        id: `tacit-${tacitPractices.length + 1}`,
        statement: requiredIndex(observationsForStatement, 0).statement,
        confidence: Math.min(1.0, 0.5 + distinctRuns.size * 0.2),
        observedRuns: Array.from(distinctRuns),
      });
    }
  }

  return tacitPractices;
}
