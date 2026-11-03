// Opt-in physical Workspace admission for a Host-managed writable Worker.
// The single-use reservation is stored in a Host-owned directory OUTSIDE the
// Worker Worktree. It is not a Kernel mutation fence or an OS writer-exit proof.
// The Host must keep reservationRoot outside all Worker writable/sandbox roots;
// no release, TTL, PID probe, or automatic retry is provided.

import { createHash, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceWriterReservationInput {
  workspaceRoot: string;
  reservationRoot: string;
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

const required = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);
const admissionError = (code: string): Error & { code: string } => (
  Object.assign(new Error(code), { code })
);

export async function reserveHostWorkspaceWriter({
  workspaceRoot,
  reservationRoot,
  runId,
  attemptId,
  workspaceId,
}: WorkspaceWriterReservationInput): Promise<WorkspaceWriterReservation> {
  if (![workspaceRoot, reservationRoot, runId, attemptId, workspaceId].every(required)) {
    throw admissionError('host_writer_reservation_identity_missing');
  }
  const canonicalRoot = await realpath(workspaceRoot);
  const hostRoot = await realpath(reservationRoot);
  const relative = path.relative(canonicalRoot, hostRoot);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw admissionError('host_writer_reservation_root_inside_workspace');
  }
  // A key derived from the canonical physical path prevents a second Host
  // using an alias of that same directory from getting another reservation.
  const key = createHash('sha256').update(canonicalRoot).digest('hex');
  const reservation: WorkspaceWriterReservation = {
    workspaceRoot: canonicalRoot,
    runId,
    attemptId,
    workspaceId,
    reservationId: randomUUID(),
  };
  let fd;
  try {
    // Atomic creation is shared by cooperating Host processes that use
    // the SAME reservationRoot on a filesystem supporting exclusive create.
    fd = await open(path.join(hostRoot, 'writer-' + key + '.json'), 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw admissionError('host_writer_workspace_already_reserved');
    }
    throw cause;
  }
  try {
    await fd.writeFile(JSON.stringify({
      schema: 1,
      runId,
      attemptId,
      workspaceId,
      reservationId: reservation.reservationId,
    }) + '\n');
    await fd.sync();
    return reservation;
  } finally {
    await fd.close();
  }
}
