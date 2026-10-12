// Generated from schemas/kernel.measurement.schema.json. Edit the schema and run build:contracts.

export type MeasurementValue =
  | {
      status: 'observed';
      value: unknown;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

export interface KernelMeasurement {
  schemaVersion: 2;
  harnessIdentity: string;
  sourceIdentity: string;
  taskIdentity: string;
  currentWorkspaceIdentity: MeasurementValue;
  hardEvidenceCoverage: MeasurementValue;
  promptTokenBudget: MeasurementValue;
  providerModelIdentity: MeasurementValue;
  modelRouting: MeasurementValue;
  estimatedStaticTokens: number;
  actualInputTokens: MeasurementValue;
  actualOutputTokens: MeasurementValue;
  successDecision: MeasurementValue;
  falseCompletionDecision: MeasurementValue;
  retryCount: MeasurementValue;
  replanCount: MeasurementValue;
  userInterventionCount: MeasurementValue;
  wallClockMs: MeasurementValue;
  evidenceCoverage: MeasurementValue;
  workflowEfficiency: MeasurementValue;
  efficiencyTelemetry: MeasurementValue;
  contaminationSignals: MeasurementValue;
}
