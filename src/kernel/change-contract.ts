type UnknownRecord = Record<string, unknown>;

export interface NormalizedChangedContract {
  changedPaths: string[];
  changedFileCount: number;
}

export const CONTRACT_CHANGE_CLASSES = [
  'clarification',
  'defect-within-scope',
  'scope-extension',
  'replacement',
] as const;

export type ContractChangeClass = typeof CONTRACT_CHANGE_CLASSES[number];

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const stringValues = (value: unknown): string[] => (
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => String(item).replace(/\\/g, '/'))
    .filter(Boolean)
);

const setEqual = (left: unknown, right: unknown): boolean => (
  JSON.stringify([...new Set(stringValues(left))].sort())
  === JSON.stringify([...new Set(stringValues(right))].sort())
);

const isWithin = (candidate: unknown, declared: unknown): boolean => {
  const declaredValues = stringValues(declared);
  return stringValues(candidate).every((item) => declaredValues.some((scope) => (
    item === scope
    || scope === '*'
    || scope === '**'
    || (scope.endsWith('/**') && item.startsWith(scope.slice(0, -2)))
    || item.startsWith(`${scope}/`)
  )));
};

const isContractChangeClass = (value: unknown): value is ContractChangeClass => (
  typeof value === 'string'
  && (CONTRACT_CHANGE_CLASSES as readonly string[]).includes(value)
);

export function normalizeChangedContract(input: unknown = {}): NormalizedChangedContract {
  const record = asRecord(input);
  const rawPaths = Array.isArray(record.changedPaths)
    ? record.changedPaths
    : Array.isArray(record.changedFiles)
      ? record.changedFiles
      : Array.isArray(record.filesChanged)
        ? record.filesChanged
        : [];

  const changedPaths = rawPaths
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .map((item) => item.replace(/\\/g, '/'));

  let changedFileCount = Number.isFinite(record.changedFileCount)
    ? Number(record.changedFileCount)
    : Number.isFinite(record.filesChanged)
      ? Number(record.filesChanged)
      : changedPaths.length;

  if (changedFileCount < changedPaths.length) changedFileCount = changedPaths.length;

  return { changedPaths, changedFileCount };
}

export const classifyContractChange = ({
  previous = null,
  next = null,
}: {
  previous?: unknown;
  next?: unknown;
} = {}): ContractChangeClass => {
  if (!previous || !next) return 'clarification';

  const previousRecord = asRecord(previous);
  const nextRecord = asRecord(next);
  const flags = asRecord(nextRecord.flags);
  const explicit = nextRecord.changeClass ?? flags.changeClass;

  if (isContractChangeClass(explicit)) return explicit;
  if (nextRecord.replacement === true || flags.replacement === true) return 'replacement';

  const previousPaths = [
    ...stringValues(previousRecord.allowedPaths),
    ...stringValues(previousRecord.forbiddenPaths),
  ];
  const nextPaths = [
    ...stringValues(nextRecord.allowedPaths),
    ...stringValues(nextRecord.forbiddenPaths),
  ];
  if (
    nextRecord.scopeExtension === true
    || flags.scopeExtension === true
    || (nextPaths.length > 0 && previousPaths.length === 0)
    || !isWithin(nextPaths, previousPaths.length > 0 ? previousPaths : ['**'])
  ) {
    return 'scope-extension';
  }

  if (
    nextRecord.defectWithinScope === true
    || flags.defectWithinScope === true
    || nextRecord.taskClass === 'bug'
  ) {
    return 'defect-within-scope';
  }

  if (
    setEqual(previousRecord.allowedPaths, nextRecord.allowedPaths)
    && setEqual(previousRecord.forbiddenPaths, nextRecord.forbiddenPaths)
  ) {
    return 'clarification';
  }
  return 'defect-within-scope';
};
