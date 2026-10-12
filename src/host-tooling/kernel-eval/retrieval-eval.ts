import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildProjectKnowledgeContext,
  type ProjectKnowledgeContext,
} from '../../kernel/knowledge/context-load.js';

type UnknownRecord = Record<string, unknown>;

interface RetrievalEvalRecord extends UnknownRecord {
  id: string;
  projectId: string;
  type: string;
  status: string;
  trustTier?: string;
  scope?: string[];
  statement?: string;
  sourceRefs?: string[];
  sourceDigest?: string | null;
}

interface RetrievalTruth {
  relevantIds: string[];
  irrelevantIds: string[];
  staleIds: string[];
  supersededIds: string[];
}

interface RetrievalEvalCase {
  id: string;
  projectId: string;
  stage: 'FRAME' | 'EXECUTE' | 'PROVE' | 'CLOSE';
  objective: string;
  changedPaths: string[];
  workspaceSeed?: Record<string, string>;
  records: RetrievalEvalRecord[];
  truth: RetrievalTruth;
}

export interface RetrievalEvalCorpus {
  schemaVersion: number;
  taskSetRevision: string;
  baselineSourceHead: string;
  metricContract: {
    retrieveDefinition: string;
    injectionDefinition: string;
    recallDenominator: string;
    precisionDenominator: string;
    staleMissDenominator: string;
    tokenMetric: string;
    latencyCold: string;
    latencyWarm: string;
    unavailableRule: string;
  };
  cases: RetrievalEvalCase[];
}

interface RatioMetric {
  status: 'available' | 'unavailable';
  numerator: number;
  denominator: number;
  value: number | null;
  reason?: string;
}

interface LatencyMetric {
  status: 'available';
  unit: 'ms';
  coldMs: number;
  warmMs: number;
  comparison: 'informational-only';
}

interface TokenMetric {
  status: 'proxy';
  unit: 'estimated_tokens_4chars';
  value: number;
  reason: 'provider-token-usage-unavailable';
}

interface CaseObservation {
  id: string;
  retrievedIds: string[];
  injectedIds: string[];
  staleOrUnavailableIds: string[];
  retrieveRecall: RatioMetric;
  retrievePrecision: RatioMetric;
  injectionRecall: RatioMetric;
  injectionPrecision: RatioMetric;
  staleMissRate: RatioMetric;
  contextTokens: TokenMetric;
  latency: LatencyMetric;
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const stableJson = (value: unknown): string => (
  JSON.stringify(stableValue(value))
);

const sha256 = (value: unknown): string => (
  `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
);

const uniqueSorted = (values: readonly string[]): string[] => (
  [...new Set(values)].sort()
);

const ratio = (
  numerator: number,
  denominator: number,
  unavailableReason: string,
): RatioMetric => (
  denominator > 0
    ? {
        status: 'available',
        numerator,
        denominator,
        value: numerator / denominator,
      }
    : {
        status: 'unavailable',
        numerator,
        denominator,
        value: null,
        reason: unavailableReason,
      }
);

const intersectionCount = (
  left: readonly string[],
  right: readonly string[],
): number => {
  const rightSet = new Set(right);
  return new Set(left.filter((entry) => rightSet.has(entry))).size;
};

const injectedRecordIds = (
  context: ProjectKnowledgeContext,
): string[] => uniqueSorted([
  ...context.policyAnchors,
  ...context.semanticFacts,
  ...context.ontologyConstraints,
].flatMap((entry) => (
  typeof entry.id === 'string' && entry.id ? [entry.id] : []
)));

const staleOrUnavailableIds = (
  context: ProjectKnowledgeContext,
): string[] => uniqueSorted(
  context.staleOrUnavailable.flatMap((entry) => (
    typeof entry.id === 'string' && entry.id ? [entry.id] : []
  )),
);

const createProjectRoot = async (
  testCase: RetrievalEvalCase,
): Promise<string> => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `kernel-retrieval-${testCase.id}-`),
  );
  for (const [relative, content] of Object.entries(
    testCase.workspaceSeed || {},
  )) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
};

const createStateStore = (testCase: RetrievalEvalCase) => ({
  getProjectKnowledgeRevision: () => 1,
  listKnowledgeRecords: ({
    projectId,
    statuses = [],
  }: {
    projectId?: string;
    statuses?: string[];
  }) => testCase.records.filter((record) => (
    (!projectId || record.projectId === projectId)
    && (
      statuses.length === 0
      || statuses.includes(record.status)
    )
  )),
});

const observeCase = async ({
  testCase,
  runtimeHome,
}: {
  testCase: RetrievalEvalCase;
  runtimeHome: string;
}): Promise<CaseObservation> => {
  const projectRoot = await createProjectRoot(testCase);
  const stateStore = createStateStore(testCase);
  const retrievedIds = uniqueSorted(
    stateStore.listKnowledgeRecords({
      projectId: testCase.projectId,
      statuses: ['committed', 'verified'],
    }).map((record) => record.id),
  );
  try {
    const input = {
      projectId: testCase.projectId,
      stage: testCase.stage,
      runId: `retrieval-eval-${testCase.id}`,
      objective: testCase.objective,
      changedPaths: testCase.changedPaths,
      projectRoot,
      stateStore,
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    };

    const coldStarted = performance.now();
    const cold = await buildProjectKnowledgeContext(input);
    const coldMs = performance.now() - coldStarted;

    const warmStarted = performance.now();
    const warm = await buildProjectKnowledgeContext(input);
    const warmMs = performance.now() - warmStarted;

    const injectedIds = injectedRecordIds(warm);
    const staleIds = uniqueSorted([
      ...testCase.truth.staleIds,
      ...testCase.truth.supersededIds,
    ]);
    const retrieveRelevant = intersectionCount(
      retrievedIds,
      testCase.truth.relevantIds,
    );
    const injectedRelevant = intersectionCount(
      injectedIds,
      testCase.truth.relevantIds,
    );
    const staleMisses = intersectionCount(injectedIds, staleIds);

    return {
      id: testCase.id,
      retrievedIds,
      injectedIds,
      staleOrUnavailableIds: staleOrUnavailableIds(warm),
      retrieveRecall: ratio(
        retrieveRelevant,
        testCase.truth.relevantIds.length,
        'no-relevant-ground-truth',
      ),
      retrievePrecision: ratio(
        retrieveRelevant,
        retrievedIds.length,
        'no-retrieved-records',
      ),
      injectionRecall: ratio(
        injectedRelevant,
        testCase.truth.relevantIds.length,
        'no-relevant-ground-truth',
      ),
      injectionPrecision: ratio(
        injectedRelevant,
        injectedIds.length,
        'no-injected-records',
      ),
      staleMissRate: ratio(
        staleMisses,
        staleIds.length,
        'no-stale-or-superseded-ground-truth',
      ),
      contextTokens: {
        status: 'proxy',
        unit: 'estimated_tokens_4chars',
        value: Math.ceil(warm.promptBlock.length / 4),
        reason: 'provider-token-usage-unavailable',
      },
      latency: {
        status: 'available',
        unit: 'ms',
        coldMs,
        warmMs,
        comparison: 'informational-only',
      },
    };
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

const aggregateRatio = (
  observations: CaseObservation[],
  metric: keyof Pick<
    CaseObservation,
    | 'retrieveRecall'
    | 'retrievePrecision'
    | 'injectionRecall'
    | 'injectionPrecision'
    | 'staleMissRate'
  >,
): RatioMetric => {
  const numerator = observations.reduce(
    (sum, observation) => sum + observation[metric].numerator,
    0,
  );
  const denominator = observations.reduce(
    (sum, observation) => sum + observation[metric].denominator,
    0,
  );
  return ratio(numerator, denominator, 'aggregate-denominator-zero');
};

const deterministicCase = (observation: CaseObservation) => ({
  id: observation.id,
  retrievedIds: observation.retrievedIds,
  injectedIds: observation.injectedIds,
  staleOrUnavailableIds: observation.staleOrUnavailableIds,
  retrieveRecall: observation.retrieveRecall,
  retrievePrecision: observation.retrievePrecision,
  injectionRecall: observation.injectionRecall,
  injectionPrecision: observation.injectionPrecision,
  staleMissRate: observation.staleMissRate,
  contextTokens: observation.contextTokens,
});

export const runKnowledgeRetrievalEvaluation = async ({
  corpus,
}: {
  corpus: RetrievalEvalCorpus;
}) => {
  const runtimeHome = await mkdtemp(
    path.join(os.tmpdir(), 'kernel-retrieval-runtime-'),
  );
  try {
    const observations: CaseObservation[] = [];
    for (const testCase of corpus.cases) {
      observations.push(await observeCase({ testCase, runtimeHome }));
    }

    const deterministic = {
      taskSetRevision: corpus.taskSetRevision,
      corpusDigest: sha256(corpus),
      caseCount: observations.length,
      aggregate: {
        retrieveRecall: aggregateRatio(observations, 'retrieveRecall'),
        retrievePrecision: aggregateRatio(observations, 'retrievePrecision'),
        injectionRecall: aggregateRatio(observations, 'injectionRecall'),
        injectionPrecision: aggregateRatio(observations, 'injectionPrecision'),
        staleMissRate: aggregateRatio(observations, 'staleMissRate'),
        contextTokenEstimate: observations.reduce(
          (sum, observation) => sum + observation.contextTokens.value,
          0,
        ),
      },
      cases: observations.map(deterministicCase),
    };

    return {
      schemaVersion: 1,
      policyRevision: 'kernel-retrieval-eval.v1',
      baselineSourceHead: corpus.baselineSourceHead,
      metricContract: corpus.metricContract,
      deterministic,
      latency: {
        status: 'available',
        unit: 'ms',
        cold: {
          condition: corpus.metricContract.latencyCold,
          samples: observations.map((observation) => ({
            id: observation.id,
            value: observation.latency.coldMs,
          })),
        },
        warm: {
          condition: corpus.metricContract.latencyWarm,
          samples: observations.map((observation) => ({
            id: observation.id,
            value: observation.latency.warmMs,
          })),
        },
        comparison: 'informational-only',
      },
    };
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
};

export const retrievalCorpusDigest = (
  corpus: RetrievalEvalCorpus,
): string => sha256(corpus);
