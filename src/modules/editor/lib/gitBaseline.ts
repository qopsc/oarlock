import type { EditorView } from "@codemirror/view";
import { normalizeToLf } from "./eol";
import { setGitBase } from "./gitGutter";

/** A read belongs to the view that requested it, and starts only once it exists. */
export function loadGitBaseline(
  view: Pick<EditorView, "dispatch"> | null,
  read: () => Promise<string | null>,
): () => void {
  if (!view) return () => {};
  let active = true;
  const apply = (base: string | null) => {
    if (active) view.dispatch({ effects: setGitBase.of(base === null ? null : normalizeToLf(base)) });
  };
  void read().then(apply, () => apply(null));
  return () => { active = false; };
}
