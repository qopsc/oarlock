import type { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef } from "react";
import { resolveLanguage } from "./languageResolver";

/** A parser belongs to the created editor and the currently selected language. */
export function useDocumentLanguage(
  view: EditorView | null,
  source: string,
  ready: boolean,
  compartment: Compartment,
  changed: (view: EditorView) => void,
  failed: (error: unknown) => void,
) {
  const generation = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate the old parser before passive effects when selection or readiness changes.
  useLayoutEffect(() => {
    generation.current++;
    if (!view) return;
    view.dispatch({ effects: compartment.reconfigure([]) });
    changed(view);
  }, [view, source, ready, compartment, changed]);
  useEffect(() => {
    if (!view || !ready) return;
    const owner = generation.current;
    let cancelled = false;
    void resolveLanguage(source)
      .then((result) => {
        if (cancelled || owner !== generation.current) return;
        view.dispatch({ effects: compartment.reconfigure(result?.ext ?? []) });
        changed(view);
      })
      .catch((error) => {
        if (!cancelled && owner === generation.current) failed(error);
      });
    return () => {
      cancelled = true;
    };
  }, [view, source, ready, compartment, changed, failed]);
}
