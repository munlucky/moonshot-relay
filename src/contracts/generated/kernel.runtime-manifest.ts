// Generated from schemas/kernel.runtime-manifest.schema.json. Edit the schema and run build:contracts.

export interface KernelRuntimeManifest {
  schemaVersion: 1;
  productId: string;
  runtimeHome: string;
  platform:
    'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
  arch: string;
  nodePath: string;
  checksum: string;
}
