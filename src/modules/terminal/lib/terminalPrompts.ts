import { create } from "zustand";

/** Something a terminal asks the user before doing it. */
export type TerminalPromptRequest =
  /** A paste that would run commands (line breaks without bracketed paste). */
  | { readonly kind: "paste"; readonly text: string }
  /**
   * A program asked to read the clipboard (OSC 52, Kitty OSC 5522); Kitty
   * reads carry the name the program gives itself.
   */
  | { readonly kind: "clipboard-read"; readonly program?: string };

export type TerminalPromptAnswer = "allow" | "deny";

type PendingPrompt = {
  readonly id: number;
  readonly owner: AbortSignal;
  readonly match: string;
  readonly promise: Promise<TerminalPromptAnswer>;
  readonly request: TerminalPromptRequest;
  readonly resolve: (answer: TerminalPromptAnswer) => void;
};

type TerminalPromptStore = {
  /** Oldest first; the dialog shows the head. */
  readonly queue: readonly PendingPrompt[];
  answer: (id: number, answer: TerminalPromptAnswer) => void;
};

/** At most this many prompts wait; later requests are denied, not stacked. */
const MAX_PENDING = 8;
let nextId = 1;

export const useTerminalPromptStore = create<TerminalPromptStore>((set) => ({
  queue: [],
  answer: (id, answer) =>
    set((state) => {
      const prompt = state.queue.find((entry) => entry.id === id);
      if (!prompt) return state;
      prompt.resolve(answer);
      return { queue: state.queue.filter((entry) => entry.id !== id) };
    }),
}));

/** Matching reads share one promise only within their live terminal generation. */
export function requestTerminalPrompt(
  request: TerminalPromptRequest,
  owner: AbortSignal,
  match = "",
): Promise<TerminalPromptAnswer> {
  if (owner.aborted) return Promise.resolve("deny");
  const { queue } = useTerminalPromptStore.getState();
  if (request.kind === "clipboard-read") {
    const waiting = queue.find(
      (entry) =>
        entry.owner === owner &&
        entry.match === match &&
        entry.request.kind === "clipboard-read" &&
        entry.request.program === request.program,
    );
    if (waiting) return waiting.promise;
  }
  if (queue.length >= MAX_PENDING) return Promise.resolve("deny");
  const id = nextId++;
  let settle!: (answer: TerminalPromptAnswer) => void;
  const promise = new Promise<TerminalPromptAnswer>((resolve) => {
    settle = resolve;
  });
  const cancel = () => useTerminalPromptStore.getState().answer(id, "deny");
  const prompt: PendingPrompt = {
    id,
    request,
    owner,
    match,
    promise,
    resolve: (answer) => {
      owner.removeEventListener("abort", cancel);
      settle(owner.aborted ? "deny" : answer);
    },
  };
  owner.addEventListener("abort", cancel, { once: true });
  useTerminalPromptStore.setState({ queue: [...queue, prompt] });
  return promise;
}
