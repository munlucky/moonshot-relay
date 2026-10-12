// Generated from schemas/kernel.session-source.schema.json. Edit the schema and run build:contracts.

export interface KernelSessionSource {
  schemaVersion: 1;
  provider: 'codex' | 'claude';
  nativeSessionId: string;
  locator?: string | null;
  workingDirectory?: string | null;
  remote?: string | null;
  sourceDigest: string;
  [k: string]: unknown | undefined;
}
