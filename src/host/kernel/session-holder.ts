import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface ResolveHostSessionHolderOptions {
  holder?: unknown;
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
}

export const resolveHostSessionHolder = ({
  holder,
  env = process.env,
  projectRoot = process.cwd(),
}: ResolveHostSessionHolderOptions = {}): string => {
  if (holder) return String(holder);
  const sessionId = String(
    env.MOON_RELAY_KERNEL_SESSION_ID
    || env.MOON_RELAY_KERNEL_SESSION
    || '',
  ).trim();
  if (sessionId) return `${os.hostname()}:session:${sessionId}`;

  const projectDigest = createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 12);

  return `${os.hostname()}:project:${projectDigest}`;
};
