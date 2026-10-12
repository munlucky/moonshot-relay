export type ProjectCommandRunner = 'npm' | 'pnpm' | 'yarn';

export interface NodeProjectCommandObservation {
  runner: ProjectCommandRunner;
  scripts: Record<string, string>;
  hasTypeScriptDependency: boolean;
  hasTypeScriptConfig: boolean;
  localTypeScriptBinary: string | null;
}

export interface MakeProjectCommandObservation {
  source: string;
  targets: string[];
}

export interface ProjectCommandDeclarationObservation {
  schemaVersion: 1;
  manifests: string[];
  node: NodeProjectCommandObservation | null;
  make: MakeProjectCommandObservation | null;
}

export interface ProjectCommand {
  commandRef: string;
  commandClass: string;
  command: string;
  args: string[];
  ecosystem: string;
  source: string;
  declaration: string;
}
