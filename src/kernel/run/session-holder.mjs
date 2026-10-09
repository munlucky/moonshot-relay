// Lease holder identity (P0-6).
//
// The holder must be stable across the separate CLI processes that make up one
// model session — `kernel next`, `kernel report`, `kernel report` again — or
// every invocation looks like a different runner and the run deadlocks behind
// its own abandoned lease. A PID is therefore the wrong identity.
//
// Order of authority:
//   1. an explicit holder passed by the embedder,
//   2. MOON_RELAY_KERNEL_SESSION_ID exported by the host that launched the model,
//   3. a stable per-host/per-project fallback so a plain CLI session still works.
//
// Cross-process safety does not rest on the holder string alone: leases carry a
// fencing token and are released when a command finishes.

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const resolveHostSessionHolder = ({ holder, env = process.env, projectRoot = process.cwd() } = {}) => {
  if (holder) return String(holder);
  const sessionId = String(env.MOON_RELAY_KERNEL_SESSION_ID || env.MOON_RELAY_KERNEL_SESSION || '').trim();
  if (sessionId) return `${os.hostname()}:session:${sessionId}`;
  const projectDigest = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  return `${os.hostname()}:project:${projectDigest}`;
};

// Report leases are short and released on completion, so a crashed process
// blocks the next one for minutes, not half an hour.
export const REPORT_LEASE_TTL_MS = 10 * 60 * 1000;
export const SESSION_LEASE_TTL_MS = 15 * 60 * 1000;
