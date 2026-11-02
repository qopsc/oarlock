import { invoke } from "@tauri-apps/api/core";
import type { DiscardBegin, DiscardChannel, DiscardEnd } from "./documentMutations";
import { prepareNativeDiscard } from "./gitSignals";

type Round = ReturnType<typeof prepareNativeDiscard>;

/** Another window's Discard, from `discard-begin` to `discard-end`. Every mounted
 * document under the discarded entries keeps its text and only gets the final
 * disk baseline; this window never replaces a buffer for a discard it did not
 * confirm. A round ends with its `discard-end`, a gap in the stream, or the
 * listener going away; nothing times out, because releasing early would let a
 * buffer equal to the disk adopt what Git writes next. */
export function createRemoteDiscards(
  ownLabel: string,
  match: (
    roots: string[],
    paths: string[],
    workspace: DiscardBegin["workspace"],
  ) => Promise<boolean[]> = (roots, paths, workspace) =>
    invoke<boolean[]>("git_discard_match", { roots, paths, workspace }),
): Omit<DiscardChannel, "currentSequence"> {
  const rounds = new Map<number, Round>();
  const drop = (id: number, round: Round) => {
    if (rounds.get(id) === round) rounds.delete(id);
    round.dispose();
  };
  return {
    begin(event: DiscardBegin) {
      if (event.origin === ownLabel || rounds.has(event.id)) return;
      const round = prepareNativeDiscard(event.workspace, true);
      rounds.set(event.id, round);
      void round
        .ready((paths) => match(event.roots, paths, event.workspace))
        .catch((error: unknown) => {
          console.warn("Discard identity lookup failed; drafts are kept", error);
          drop(event.id, round);
        });
    },
    end(event: DiscardEnd) {
      const round = rounds.get(event.id);
      if (!round) return;
      rounds.delete(event.id);
      if (event.ok) round.complete();
      else round.dispose();
    },
    reset() {
      for (const [id, round] of [...rounds]) drop(id, round);
    },
  };
}
