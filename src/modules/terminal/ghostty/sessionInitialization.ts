export type SessionInitializationState = {
  generation: number;
  disposed: boolean;
  initializing: Promise<void> | null;
};

/** A slow close belongs only to the generation and session that started it. */
export async function waitForSessionClose(
  state: SessionInitializationState,
  generation: number,
  close: () => Promise<void>,
  ownsSession: () => boolean,
): Promise<boolean> {
  const current = () => !state.disposed && state.generation === generation && ownsSession();
  try { await close(); }
  catch (error) { if (current()) throw error; return false; }
  return current();
}

export function initializeSessionGeneration(
  state: SessionInitializationState,
  initialize: (generation: number) => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  if (state.initializing) return state.initializing;
  const generation = ++state.generation;
  state.initializing = initialize(generation).catch((error: unknown) => {
    if (!state.disposed && generation === state.generation) onFailure(error);
  });
  return state.initializing;
}
