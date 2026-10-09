// Classifies verification failures relative to a pre-change baseline (§16.3)
// into three mutually-exclusive buckets, so unrelated pre-existing breakage
// does not block the task and genuine task-caused regressions are not excused
// as "already broken".
//
// Each current failure lands in exactly one bucket:
// - taskBlocking: touches a changed path (our fault regardless of baseline)
// - preExisting: was failing at baseline and does not touch a changed path
// - unrelated: newly failing but touches no changed path (ambient / flaky)

const overlapsChangedPaths = (failure, changedPaths = []) => {
  const refs = [failure.obligationId, failure.commandRef, failure.command, ...(failure.paths || [])]
    .filter(Boolean)
    .map(String);
  return changedPaths.some((changed) => refs.some((ref) => ref.includes(changed) || changed.includes(ref)));
};

const failureIdentityKeys = (failure) => [failure?.obligationId, failure?.commandRef, failure?.command]
  .filter(Boolean)
  .map(String);

export const classifyFailures = ({ baselineFailures = [], currentFailures = [], changedPaths = [] } = {}) => {
  // A baseline may be captured from a project command catalog before the run
  // obligations are compiled. The later proof receipt can therefore carry a
  // different obligation id for the same command. Match any stable identity
  // field so that this representation change does not turn pre-existing
  // breakage into a newly introduced failure.
  const baselineKeys = new Set(baselineFailures.flatMap(failureIdentityKeys));

  const taskBlockingFailures = [];
  const unrelatedFailures = [];
  const preExistingFailures = [];

  for (const failure of currentFailures) {
    const wasFailingAtBaseline = failureIdentityKeys(failure).some((key) => baselineKeys.has(key));
    const touchesChange = overlapsChangedPaths(failure, changedPaths);

    if (touchesChange) taskBlockingFailures.push(failure);
    else if (wasFailingAtBaseline) preExistingFailures.push(failure);
    else unrelatedFailures.push(failure);
  }

  return { taskBlockingFailures, unrelatedFailures, preExistingFailures };
};
