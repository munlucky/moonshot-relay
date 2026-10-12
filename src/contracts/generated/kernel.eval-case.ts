// Generated from schemas/kernel.eval-case.schema.json. Edit the schema and run build:contracts.

export interface KernelEvalCase {
  id: {
    [k: string]: unknown | undefined;
  };
  taskClass: 'analysis' | 'bug' | 'feature' | 'refactor' | 'ui' | 'long-running';
  riskTier: 'T0' | 'T1' | 'T2' | 'T3';
  objective: string;
  /**
   * @minItems 2
   */
  expectedRoute: [
    'FRAME' | 'SHAPE' | 'SLICE' | 'SCHEDULE' | 'EXECUTE' | 'PROVE' | 'CLOSE',
    'FRAME' | 'SHAPE' | 'SLICE' | 'SCHEDULE' | 'EXECUTE' | 'PROVE' | 'CLOSE',
    ...('FRAME' | 'SHAPE' | 'SLICE' | 'SCHEDULE' | 'EXECUTE' | 'PROVE' | 'CLOSE')[]
  ];
  sourceKind: 'historical' | 'synthetic';
  /**
   * @minItems 1
   */
  requiredEvidence: [string, ...string[]];
}
