export const STATES = ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'] as const;
export type KernelState = typeof STATES[number];

export const TRANSITIONS: Readonly<Record<KernelState, readonly KernelState[]>> = Object.freeze({
  FRAME: ['EXECUTE', 'CLOSE'],
  EXECUTE: ['PROVE', 'FRAME'],
  PROVE: ['CLOSE', 'EXECUTE', 'FRAME'],
  CLOSE: [],
});

export interface TransitionSnapshot {
  state: KernelState;
  history?: KernelState[];
  [key: string]: unknown;
}

export const canTransition = (from: unknown, to: unknown): boolean => (
  STATES.includes(from as KernelState)
  && STATES.includes(to as KernelState)
  && TRANSITIONS[from as KernelState].includes(to as KernelState)
);

export const transition = <T extends TransitionSnapshot>(
  snapshot: T,
  to: KernelState,
): T & { state: KernelState; history: KernelState[] } => {
  if (!canTransition(snapshot.state, to)) {
    throw new Error(`Invalid Kernel transition ${snapshot.state} -> ${to}`);
  }
  return {
    ...snapshot,
    state: to,
    history: [...(snapshot.history || []), to],
  };
};
