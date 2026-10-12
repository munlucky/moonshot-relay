/** Host adapter requests have one finite dispatch boundary. Provider results are validated by the caller. */
export interface HostAdapterDispatchRequest extends Record<string, unknown> {
  decision: Record<string, unknown> & { role: string };
  resolution: Record<string, unknown>;
  modelInput?: Record<string, unknown>;
}
export type HostAdapterDispatch = (input: HostAdapterDispatchRequest) => unknown | Promise<unknown>;
