export const STATES = Object.freeze(['FRAME','EXECUTE','PROVE','CLOSE']);
export const TRANSITIONS = Object.freeze({
  FRAME: ['EXECUTE','CLOSE'],
  EXECUTE: ['PROVE','FRAME'],
  PROVE: ['CLOSE','EXECUTE','FRAME'],
  CLOSE: [],
});
export const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));
export const transition = (snapshot, to) => {
  if (!canTransition(snapshot.state, to)) throw new Error(`Invalid Kernel transition ${snapshot.state} -> ${to}`);
  return { ...snapshot, state: to, history: [...(snapshot.history || []), to] };
};
