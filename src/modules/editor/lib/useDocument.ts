import { registerDiscardDocument } from "./gitSignals";
import { notifyDocumentSaved } from "@/modules/lsp";
import { dismissFileError, showFileError } from "@/modules/mac-privacy";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useOwnedWorkspace } from "@/modules/workspace/owner";
import { workspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace/env";
import { observeNativeRecoveryTarget } from "./recoveryTarget";
import { workspaceEnvForPath } from "@/modules/workspace";
import { authorizationSettled } from "@/modules/workspace/authorize";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type DocumentHost,
  type DocumentIo,
  DocumentSession,
  type DocumentState,
  type ReadResult,
  type SaveResult,
} from "./documentSession";

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  onBindingChange?: (path: string, detached: boolean) => void;
};

// A tab opened a moment ago may still be waiting for its folder's authorization.
// A document is read and written in the environment its path names, so a host
// file (a custom theme in the app's config folder) opens in a WSL window too.
export function createDocumentIo(owner: WorkspaceEnv): DocumentIo {
  return {
    observeRecovery: (path) => {
      const workspace = workspaceEnvForPath(path, owner);
      return observeNativeRecoveryTarget(path, workspaceScopeKey(workspace), {
        begin: () => invoke<string>("fs_recovery_begin", { path, workspace }),
        changed: (id) => invoke<boolean>("fs_recovery_changed", { id }),
        end: (id) => invoke("fs_recovery_end", { id }),
      });
    },
    read: (path, force) => {
      const workspace = workspaceEnvForPath(path, owner);
      return authorizationSettled(path, workspace).then(() =>
        invoke<ReadResult>("fs_read_file", {
          path,
          workspace,
          force,
          versioned: true,
        }),
      );
    },
    write: (path, content, expectedVersion) =>
      invoke<SaveResult>("fs_save_document", {
        path,
        content,
        expectedVersion,
        workspace: workspaceEnvForPath(path, owner),
      }),
  };
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function documentHost(
  setDoc: (doc: DocumentState) => void,
  setDirty: (dirty: boolean) => void,
  binding: (path: string, detached: boolean) => void,
): DocumentHost {
  return {
    state: setDoc,
    binding,
    retained: (path) =>
      toast.info("Editor text retained", {
        description: `${fileName(path)} was discarded while this editor held independent work. Your text is still in the editor.`,
      }),
    dirty: setDirty,
    saved: (path) => {
      // A successful write supersedes any earlier failure or conflict notice.
      dismissFileError(`save-error:${path}`);
      toast.dismiss(`save-conflict:${path}`);
      notifyDocumentSaved(path);
    },
    saveFailed: (path, error) => {
      console.error("[save]", path, error);
      showFileError(`Could not save ${fileName(path)}`, {
        path,
        error,
        id: `save-error:${path}`,
        description: String(error),
      });
    },
    // Stays until the user acts, a write lands, or the pane leaves the path.
    conflict: (path, overwrite) => {
      toast.warning("File changed on disk", {
        id: `save-conflict:${path}`,
        description: `${fileName(path)} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Overwrite", onClick: overwrite },
      });
    },
    released: (path) => {
      toast.dismiss(`save-conflict:${path}`);
    },
    autoSave: () => {
      const prefs = usePreferencesStore.getState();
      return {
        enabled: prefs.editorAutoSave,
        delay: prefs.editorAutoSaveDelay,
      };
    },
  };
}

export function useDocument({ path, onDirtyChange, onBindingChange }: Options) {
  const owner = useOwnedWorkspace();
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [detached, setDetached] = useState(false);
  const bindingRef = useRef(onBindingChange);
  bindingRef.current = onBindingChange;
  const [session] = useState(
    () =>
      new DocumentSession(
        createDocumentIo(owner),
        documentHost(setDoc, setDirty, (nextPath, detached) => {
          setDetached(detached);
          bindingRef.current?.(nextPath, detached);
        }),
      ),
  );

  useLayoutEffect(() => session.open(path), [session, path]);
  useLayoutEffect(() => () => session.close(), [session]);
  useLayoutEffect(
    () =>
      registerDiscardDocument({
        path,
        workspace: workspaceEnvForPath(path, owner),
        prepare: session.prepareDiscard,
        stage: session.stageDiscard,
      }),
    [session, path, owner],
  );

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  return {
    doc,
    detached,
    detach: session.detach,
    retarget: session.retarget,
    bindingSnapshot: session.bindingSnapshot,
    isDetached: session.isDetached,
    recover: session.recover,
    canComplete: session.canComplete,
    dirty,
    onChange: session.change,
    save: session.save,
    isSaved: session.isSaved,
    hasUnsavedChanges: session.hasUnsavedChanges,
    closeRevision: session.closeRevision,
    formatAndSave: session.formatAndSave,
    reload: session.reload,
    prepareDiscard: session.prepareDiscard,
    text: session.text,
    adoptDiskText: session.adoptDiskText,
    openAnyway: session.openAnyway,
  };
}
