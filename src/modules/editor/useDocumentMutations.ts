import { useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toast } from "sonner";
import {
  subscribeDocumentMutations,
  type DocumentMutation,
} from "./lib/documentMutations";

/** Each mutation is committed before the next event reads the tab identities. */
export function useDocumentMutations(apply: (event: DocumentMutation) => void) {
  const current = useRef(apply);
  useLayoutEffect(() => {
    current.current = apply;
  }, [apply]);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const start = () => {
      if (!live) return;
      stop?.();
      stop = subscribeDocumentMutations(
        (receive) =>
          getCurrentWebviewWindow().listen<DocumentMutation>(
            "fs:mutation",
            (event) => receive(event.payload),
          ),
        (event) => flushSync(() => current.current(event)),
        (error) =>
          toast.error("Document updates unavailable", {
            id: "document-mutations",
            description: `Other windows' renames and deletions cannot be synchronized. ${String(error)}`,
            duration: Infinity,
            action: { label: "Retry", onClick: start },
          }),
        () => toast.dismiss("document-mutations"),
      );
    };
    start();
    return () => {
      live = false;
      stop?.();
      toast.dismiss("document-mutations");
    };
  }, []);
}
