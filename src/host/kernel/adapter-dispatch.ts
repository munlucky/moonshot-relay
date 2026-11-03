/** Host adapter requests have one finite dispatch boundary. Provider results are validated by the caller. */
export interface HostAdapterDispatchRequest extends Record<string, unknown> {
  decision: Record<string, unknown> & { role: string };
  resolution: Record<string, unknown>;
  modelInput?: Record<string, unknown>;
}
export type HostAdapterDispatch = (input: HostAdapterDispatchRequest) => unknown | Promise<unknown>;


// A Host-owned Native transport may emit these observations while its turn is
// running. The binding is diagnostic only: processId is a provider handle,
// not an OS PID or evidence that the underlying writer has terminated.
export interface NativeExecutionOwner {
  runId: string;
  stepId: string;
  attemptId: string;
  workspaceId: string;
}

export interface NativeExecutionObservation extends NativeExecutionOwner {
  method: 'item/started' | 'item/completed';
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string | null;
}

export type NativeExecutionObserver = (observation: NativeExecutionObservation) => void;

/** IDs from the Host-owned thread/start and turn/start RPC results. */
export interface NativeStartedTurn {
  threadId: string;
  turnId: string;
}

const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const identity = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

// Parse only commandExecution identity, not arbitrary command text, output or
// model-provided owner metadata. The canonical owner comes from the Kernel.
export const bindNativeCommandEvent = (
  owner: NativeExecutionOwner,
  event: unknown,
  startedTurn: NativeStartedTurn | null,
): NativeExecutionObservation | null => {
  const notification = record(event);
  const params = record(notification?.params);
  const item = record(params?.item);
  const method = notification?.method;
  const threadId = identity(params?.threadId);
  const turnId = identity(params?.turnId);
  const itemId = identity(item?.id);
  const expectedThreadId = identity(startedTurn?.threadId);
  const expectedTurnId = identity(startedTurn?.turnId);
  if (
    !expectedThreadId || !expectedTurnId
    || threadId !== expectedThreadId || turnId !== expectedTurnId
    || (method !== 'item/started' && method !== 'item/completed')
    || item?.type !== 'commandExecution'
    || !threadId || !turnId || !itemId
  ) return null;
  const handle = item.processId;
  const processId = identity(handle)
    || (typeof handle === 'number' && Number.isSafeInteger(handle) && handle >= 0 ? String(handle) : null);
  return {
    ...owner,
    method,
    threadId,
    turnId,
    itemId,
    processId,
  };
};
