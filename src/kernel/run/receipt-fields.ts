export const canonicalReceiptPaths = (paths: unknown): string[] => (
  [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((value) => String(value).replaceAll('\\', '/').replace(/^\.\//u, ''))
      .filter(Boolean),
  )].sort()
);

const canonicalReceiptValue = (field: string, value: unknown): unknown => (
  field === 'changedPaths' ? canonicalReceiptPaths(value) : value
);

export const receiptValueIsMissing = (field: string, value: unknown): boolean => (
  value === null
  || value === undefined
  || (Array.isArray(value) && value.length === 0)
  || (
    field === 'workerReport'
    && Boolean(value)
    && typeof value === 'object'
    && Object.keys(value as Record<string, unknown>).length === 0
  )
);

const receiptValuesEqual = (field: string, left: unknown, right: unknown): boolean => (
  JSON.stringify(canonicalReceiptValue(field, left))
  === JSON.stringify(canonicalReceiptValue(field, right))
);

export const mergeImmutableReceiptFields = (
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const nextValue = incoming?.[field];
    if (receiptValueIsMissing(field, nextValue)) continue;
    const currentValue = current?.[field];
    if (receiptValueIsMissing(field, currentValue)) {
      patch[field] = field === 'changedPaths' ? canonicalReceiptPaths(nextValue) : nextValue;
      continue;
    }
    if (!receiptValuesEqual(field, currentValue, nextValue)) {
      throw Object.assign(
        new Error(`step result field ${field} is immutable for the canonical attempt`),
        {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field,
        },
      );
    }
  }
  return patch;
};
