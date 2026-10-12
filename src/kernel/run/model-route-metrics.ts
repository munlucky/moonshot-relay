import type { EnforcementStatus } from '../../contracts/model-execution.js';
import type { NormalizedModelRouteDecision } from '../../contracts/model-route.js';

type TokenField =
  | 'eligiblePrefixTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'inputTokens'
  | 'cachedInputTokens'
  | 'outputTokens'
  | 'reasoningTokens';

export interface ModelUsageMetricReceipt {
  decisionId: string;
  enforcementStatus: EnforcementStatus;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  eligiblePrefixTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  reasoningTokens?: number | null;
  sessionLineageId?: string | null;
  cacheMissReason?: string | null;
  resolvedModel?: string | null;
}

const ratio = (
  numerator: number | null,
  denominator: number | null,
): number | null => (
  numerator === null || denominator === null || !denominator
    ? null
    : numerator / denominator
);

const sum = (
  receipts: readonly ModelUsageMetricReceipt[],
  field: TokenField,
): number | null => receipts.reduce<number | null>((total, receipt) => {
  const value = receipt[field];
  return value === null || value === undefined
    ? total
    : (total ?? 0) + value;
}, null);

const pairedRatio = (
  receipts: readonly ModelUsageMetricReceipt[],
  numeratorField: TokenField,
  denominatorField: TokenField,
): number | null => {
  let numerator: number | null = null;
  let denominator: number | null = null;
  for (const receipt of receipts) {
    const numValue = receipt[numeratorField];
    const denValue = receipt[denominatorField];
    if (
      numValue === null
      || numValue === undefined
      || denValue === null
      || denValue === undefined
    ) {
      continue;
    }
    numerator = (numerator ?? 0) + numValue;
    denominator = (denominator ?? 0) + denValue;
  }
  return ratio(numerator, denominator);
};

export const summarizeCacheEconomics = (
  receipts: readonly ModelUsageMetricReceipt[] = [],
) => {
  const eligiblePrefixTokens = sum(receipts, 'eligiblePrefixTokens');
  const cacheReadInputTokens = sum(receipts, 'cacheReadInputTokens');
  const cacheWriteInputTokens = sum(receipts, 'cacheWriteInputTokens');
  const inputTokens = sum(receipts, 'inputTokens');
  const outputTokens = sum(receipts, 'outputTokens');
  const reasoningTokens = sum(receipts, 'reasoningTokens');
  const continuationEligible = receipts.filter(
    (receipt) => receipt.sessionLineageId !== null,
  );
  const continued = continuationEligible.filter((receipt, index, all) => (
    all.findIndex(
      (other) => other.sessionLineageId === receipt.sessionLineageId,
    ) !== index
  ));
  const missReasons = receipts
    .map((receipt) => receipt.cacheMissReason)
    .filter((reason): reason is string => Boolean(reason));

  return Object.freeze({
    schemaVersion: 1,
    receipts: receipts.length,
    totals: Object.freeze({
      eligiblePrefixTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
    }),
    eligibleHitRatio: pairedRatio(
      receipts,
      'cacheReadInputTokens',
      'eligiblePrefixTokens',
    ),
    totalInputCacheRatio: pairedRatio(
      receipts,
      'cacheReadInputTokens',
      'inputTokens',
    ),
    writeReadRatio: pairedRatio(
      receipts,
      'cacheWriteInputTokens',
      'cacheReadInputTokens',
    ),
    reasoningRatio: pairedRatio(
      receipts,
      'reasoningTokens',
      'outputTokens',
    ),
    sessionContinuationRate: continuationEligible.length
      ? continued.length / continuationEligible.length
      : null,
    missReasons: Object.freeze(Object.fromEntries(
      [...new Set(missReasons)]
        .sort()
        .map((reason) => [
          reason,
          receipts.filter((receipt) => receipt.cacheMissReason === reason).length,
        ]),
    )),
  });
};

type RouteDecisionMetric = Pick<
  NormalizedModelRouteDecision,
  'decisionId' | 'modelClass' | 'reasonCodes' | 'independentContextRequired'
>;

interface RoutingTokenSummary {
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reportedTurns: number;
}

interface ModelRoutingSummary {
  totalTurns: number;
  frontierTurns: number;
  valueTurns: number;
  kernelOnlyActions: number;
  escalatedTurns: number;
  independentReviewTurns: number;
  enforcedTurns: number;
  fallbackTurns: number;
  advisoryTurns: number;
  unsupportedTurns: number;
  failedTurns: number;
  receiptCoverage: {
    receipts: number;
    providerTurns: number;
  };
  tokens: RoutingTokenSummary;
  resolvedModels: string[];
}

export const summarizeModelRouting = (
  decisions: readonly RouteDecisionMetric[] = [],
  receipts: readonly ModelUsageMetricReceipt[] = [],
): ModelRoutingSummary => {
  const byDecision = new Map(
    decisions.map((decision) => [decision.decisionId, decision]),
  );
  const summary: ModelRoutingSummary = {
    totalTurns: decisions.length,
    frontierTurns: decisions.filter(
      (decision) => decision.modelClass === 'frontier_reasoning',
    ).length,
    valueTurns: decisions.filter(
      (decision) => decision.modelClass === 'value_coding',
    ).length,
    kernelOnlyActions: decisions.filter(
      (decision) => decision.modelClass === 'kernel',
    ).length,
    escalatedTurns: decisions.filter((decision) => decision.reasonCodes.some(
      (code) => (
        code.endsWith('_ESCALATION')
        || code.endsWith('_REPLAN')
        || code === 'PROTECTED_OBLIGATION_FAILURE'
      ),
    )).length,
    independentReviewTurns: decisions.filter(
      (decision) => decision.independentContextRequired === true,
    ).length,
    enforcedTurns: 0,
    fallbackTurns: 0,
    advisoryTurns: 0,
    unsupportedTurns: 0,
    failedTurns: 0,
    receiptCoverage: {
      receipts: receipts.length,
      providerTurns: decisions.filter(
        (decision) => decision.modelClass !== 'kernel',
      ).length,
    },
    tokens: {
      input: null,
      cachedInput: null,
      output: null,
      reportedTurns: 0,
    },
    resolvedModels: [],
  };

  for (const receipt of receipts) {
    switch (receipt.enforcementStatus) {
      case 'enforced': summary.enforcedTurns += 1; break;
      case 'fallback': summary.fallbackTurns += 1; break;
      case 'advisory': summary.advisoryTurns += 1; break;
      case 'unsupported': summary.unsupportedTurns += 1; break;
      case 'failed': summary.failedTurns += 1; break;
    }
    if (receipt.inputTokens === null && receipt.outputTokens === null) continue;
    summary.tokens.reportedTurns += 1;
    summary.tokens.input = (summary.tokens.input ?? 0) + (receipt.inputTokens ?? 0);
    summary.tokens.cachedInput = (
      (summary.tokens.cachedInput ?? 0) + (receipt.cachedInputTokens ?? 0)
    );
    summary.tokens.output = (
      (summary.tokens.output ?? 0) + (receipt.outputTokens ?? 0)
    );
  }

  summary.resolvedModels = [
    ...new Set(
      receipts
        .map((receipt) => {
          if (!receipt.resolvedModel) return null;
          const modelClass = byDecision.get(receipt.decisionId)?.modelClass || 'unknown';
          return `${modelClass}:${receipt.resolvedModel}`;
        })
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return summary;
};
