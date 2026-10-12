// Generated from schemas/kernel.task-contract.schema.json. Edit the schema and run build:contracts.

export interface KernelTaskContract {
  schemaVersion: 1;
  objective: string;
  /**
   * @minItems 1
   */
  acceptance: [string, ...string[]];
  scope: string[];
  nonGoals: string[];
  riskTier: 'T0' | 'T1' | 'T2' | 'T3';
  surfaces?: (
    'security_boundary' | 'data_migration' | 'public_contract' | 'schema_change' | 'runtime_authority' | 'installer'
  )[];
  activeTrack?: 'relay' | 'kernel';
}
