export interface SourceModule {
  id: string;
  source: string;
  output: string;
  exclusiveOutput?: boolean;
  typescriptExtension?: string;
  dependencies: string[];
}
export interface SourceLayout {
  schemaVersion: 1;
  modules: SourceModule[];
  exceptions?: { from: string; to: string; reason: string }[];
  externalImports?: { from: string; specifier: string }[];
}
export interface ModuleReference { specifier: string; start: number; end: number; }
export interface SourceEntry {
  source: string;
  output: string;
  module: SourceModule;
  text: string;
  references: ModuleReference[];
}
export interface RuntimeFile {
  source: string;
  output: string;
  sourceDigest: string;
  outputDigest: string;
}
export interface RuntimeOutput extends RuntimeFile { code: string; }
export interface RuntimeManifest {
  schemaVersion: number;
  compiler: string;
  tools: Record<string, string>;
  files: RuntimeFile[];
}
