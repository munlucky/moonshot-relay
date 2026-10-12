export interface ChangeDiffInput {
  changedFiles?: string[];
  diffSummary?: string;
}

export function analyzeChangeDiff({ changedFiles = [], diffSummary: _diffSummary = '' }: ChangeDiffInput) {
  const fileGroups: Record<'source' | 'test' | 'schema' | 'docs' | 'other', string[]> = {
    source: [],
    test: [],
    schema: [],
    docs: [],
    other: [],
  };

  for (const file of changedFiles) {
    if (file.endsWith('.test.mjs') || file.includes('/tests/')) fileGroups.test.push(file);
    else if (file.endsWith('.schema.json') || file.includes('/schemas/')) fileGroups.schema.push(file);
    else if (file.endsWith('.md') || file.includes('/docs/')) fileGroups.docs.push(file);
    else if (file.endsWith('.mjs') || file.endsWith('.js') || file.endsWith('.ts')) fileGroups.source.push(file);
    else fileGroups.other.push(file);
  }

  return {
    changedFiles,
    fileGroups,
    hasSourceChanges: fileGroups.source.length > 0,
    hasTestChanges: fileGroups.test.length > 0,
  };
}
