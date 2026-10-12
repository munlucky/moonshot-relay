export interface VerificationFailureLike {
  obligationId?: unknown;
  commandRef?: unknown;
  command?: unknown;
  paths?: unknown[];
  [key: string]: unknown;
}

const overlapsChangedPaths = (failure: VerificationFailureLike, changedPaths: string[] = []) => {
  const refs = [
    failure.obligationId,
    failure.commandRef,
    failure.command,
    ...(Array.isArray(failure.paths) ? failure.paths : []),
  ].filter(Boolean).map(String);
  return changedPaths.some((changed) => refs.some((ref) => ref.includes(changed) || changed.includes(ref)));
};

const failureIdentityKeys = (failure: VerificationFailureLike): string[] => (
  [failure.obligationId, failure.commandRef, failure.command].filter(Boolean).map(String)
);

export interface ClassifyFailuresInput<T extends VerificationFailureLike = VerificationFailureLike> {
  baselineFailures?: T[];
  currentFailures?: T[];
  changedPaths?: string[];
}

export const classifyFailures = <T extends VerificationFailureLike = VerificationFailureLike>({
  baselineFailures = [],
  currentFailures = [],
  changedPaths = [],
}: ClassifyFailuresInput<T> = {}) => {
  const baselineKeys = new Set(baselineFailures.flatMap(failureIdentityKeys));
  const taskBlockingFailures: T[] = [];
  const unrelatedFailures: T[] = [];
  const preExistingFailures: T[] = [];

  for (const failure of currentFailures) {
    const wasFailingAtBaseline = failureIdentityKeys(failure).some((key) => baselineKeys.has(key));
    const touchesChange = overlapsChangedPaths(failure, changedPaths);
    if (touchesChange) taskBlockingFailures.push(failure);
    else if (wasFailingAtBaseline) preExistingFailures.push(failure);
    else unrelatedFailures.push(failure);
  }

  return { taskBlockingFailures, unrelatedFailures, preExistingFailures };
};
