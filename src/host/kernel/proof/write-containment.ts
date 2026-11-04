// Opt-in trusted Proof filesystem write boundary. Never report isolation if
// the OS cannot enforce it; a workspace pathname alone is not a sandbox.
import { existsSync, realpathSync } from 'node:fs';

export class ProofWriteContainmentUnavailableError extends Error {
  readonly code = 'PROOF_WRITE_CONTAINMENT_UNAVAILABLE';
}

const darwinSandboxExecutable = '/usr/bin/sandbox-exec';

export const confineTrustedProofWrites = ({
  projectRoot,
  writeScope,
  command,
  args,
}: {
  projectRoot: string;
  writeScope: string;
  command: string;
  args: readonly string[];
}): { command: string; args: string[]; mechanism: 'macos-seatbelt'; scope: string } => {
  // Linux/Windows require an independently demonstrated kernel-enforced
  // boundary; silently falling back to ordinary spawn is forbidden.
  if (process.platform !== 'darwin' || !existsSync(darwinSandboxExecutable)) {
    throw new ProofWriteContainmentUnavailableError('trusted Proof write containment is unavailable on this Host');
  }
  const cwd = realpathSync(projectRoot);
  const scope = realpathSync(writeScope);
  if (cwd !== scope) {
    throw new ProofWriteContainmentUnavailableError('trusted Proof write scope must exactly match its physical working directory');
  }
  // Canonical paths matter on macOS (/tmp -> /private/tmp). A detached child
  // inherits the OS sandbox. This denies writes anywhere outside the one
  // physical Proof Worktree, including sibling Worktrees and the Owner.
  const profile = `(version 1)\n(allow default)\n(deny file-write* (require-not (subpath ${JSON.stringify(scope)})))\n`;
  return {
    command: darwinSandboxExecutable,
    args: ['-p', profile, command, ...args],
    mechanism: 'macos-seatbelt',
    scope,
  };
};
