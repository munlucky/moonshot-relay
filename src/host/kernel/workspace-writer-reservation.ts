// Opt-in physical Workspace admission for a Host-managed writable Worker.
//
// This is intentionally NOT a replacement for the Kernel mutation lock or
// Owner Delivery CAS. The marker lives *in the physical Workspace* so another
// process using that same directory sees it even when the Kernel lease expires.
// There is no TTL, PID inference, automatic unlock or cross-Workspace fallback.
// An unverified exit must not cause a second writer to be admitted.
//
// Once a Worker has been admitted, its Workspace is single-use. The existing
// isolated Worktree teardown may remove the entire Workspace only after it has
// verified that the original Writer and descendants can no longer mutate it.
// Do not expose an independent "release this marker" API.

import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceWriterReservationInput {
  workspaceRoot: string;
  runId: string;
  attemptId: string;
  workspaceId: string;
}

export interface WorkspaceWriterReservation {
  workspaceRoot: string;
  runId: string;
  attemptId: string;
  workspaceId: string;
  reservationId: string;
}

const MARKER = '.moon-relay-host-writer-reservation';

const required = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const admissionError = (code: string): Error & { code: string } => (
  Object.assign(new Error(code), { code })
);

export async function reserveHostWorkspaceWriter({
  workspaceRoot,
  runId,
  attemptId,
  workspaceId,
}: WorkspaceWriterReservationInput): Promise<WorkspaceWriterReservation> {
  if (![workspaceRoot, runId, attemptId, workspaceId].every(required)) {
    throw admissionError('host_writer_reservation_identity_missing');
  }
  // Physical canonical root rather than lexical path: ../ and symlink aliases
  // cannot reserve the same physical Workspace twice on one filesystem.
  const canonicalRoot = await realpath(workspaceRoot);
  const reservation: WorkspaceWriterReservation = {
    workspaceRoot: canonicalRoot,
    runId,
    attemptId,
    workspaceId,
    reservationId: randomUUID(),
  };
  // open('wx') is an exclusive *filesystem* creation, not an expiring lease.
  // An empty marker after a crash is also a denial, never a free Workspace.
  let fd;
  try {
    fd = await open(path.join(canonicalRoot, MARKER), 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw admissionError('host_writer_workspace_already_reserved');
    }
    throw cause;
  }
  try {
    await fd.writeFile(JSON.stringify({
      schema: 1,
      runId: reservation.runId,
      attemptId: reservation.attemptId,
      workspaceId: reservation.workspaceId,
      reservationId: reservation.reservationId,
    }) + '\n');
    await fd.sync();
    return reservation;
  } finally {
    await fd.close();
  }
}
