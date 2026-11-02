import { useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toast } from "sonner";
import {
  subscribeDocumentMutations,
  type DocumentMutation,
  type PathMutation,
} from "./lib/documentMutations";
import { createRemoteDiscards } from "./lib/remoteDiscard";
import type { WorkspaceEnv } from "@/modules/workspace/env";

/** Each mutation is committed before the next event reads the tab identities. */
export function useDocumentMutations(
  apply: (event: PathMutation) => void,
  reconcile: (workspace: WorkspaceEnv | undefined, isLive: () => boolean, failedEvent?: PathMutation) => Promise<void>,
) {
  const current = useRef(apply);
  const currentReconcile = useRef(reconcile);
  useLayoutEffect(() => {
    current.current = apply;
    currentReconcile.current = reconcile;
  }, [apply, reconcile]);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const start = () => {
      if (!live) return;
      stop?.();
      const discards = {
        ...createRemoteDiscards(getCurrentWebviewWindow().label),
        currentSequence: () => invoke<number>("fs_mutation_sequence"),
      };
      stop = subscribeDocumentMutations(
        (receive) =>
          getCurrentWebviewWindow().listen<DocumentMutation>(
            "fs:mutation",
            (event) => receive(event.payload),
          ),
        (event) => flushSync(() => current.current(event)),
        (error, retry) =>
          toast.error("Document updates unavailable", {
            id: "document-mutations",
            description: `Other windows' renames and deletions cannot be synchronized. ${String(error)}`,
            duration: Infinity,
            action: { label: "Retry", onClick: retry ?? start },
          }),
        () => toast.dismiss("document-mutations"),
        (workspace, isLive, failedEvent) => currentReconcile.current(workspace, isLive, failedEvent),
        discards,
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
