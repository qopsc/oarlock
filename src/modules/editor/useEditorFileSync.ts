import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import {
  LOCAL_WORKSPACE,
  workspaceEnvForPath,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace/env";
import {
  listenFsChanged,
  createFileWatchClient,
} from "@/modules/explorer/lib/watch";
import type { Tab } from "@/modules/tabs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";
import { installDiscardCoordinator } from "./lib/discardBridge";
import { fileWatchTargets } from "./lib/fileWatchTargets";

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
};

/**
 * Keeps open editor tabs in sync with on-disk changes: reloads on applied AI
 * diffs, external writes, fs-watch events and git discards, and maintains the
 * watch set for the directories of open editor and Markdown files.
 */
export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs, editorRefs]);

  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source === "editor") return;
          const normalizedPath = event.payload.path.replace(/\\/g, "/");
          const currentTabs = tabsRef.current;
          for (const t of currentTabs) {
            if (t.kind !== "editor") continue;
            if (t.path.replace(/\\/g, "/") === normalizedPath) {
              editorRefs.current.get(t.id)?.reload();
            }
          }
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [tabsRef, editorRefs]);

  useEffect(installDiscardCoordinator, []);

  const spaces = useSpaces((s) => s.spaces);
  const watches = useRef(
    new Map<
      string,
      {
        env: WorkspaceEnv;
        tabs: Tab[];
        client: ReturnType<typeof createFileWatchClient>;
      }
    >(),
  );

  useEffect(() => {
    const next = new Map<
      string,
      {
        env: WorkspaceEnv;
        tabs: Tab[];
        client: ReturnType<typeof createFileWatchClient>;
      }
    >();
    for (const tab of tabs) {
      if (tab.kind !== "editor" && tab.kind !== "markdown") continue;
      const env = workspaceEnvForPath(
        tab.path,
        spaces.find((s) => s.id === tab.spaceId)?.env ?? LOCAL_WORKSPACE,
      );
      const key = workspaceScopeKey(env);
      const group = next.get(key) ?? {
        env,
        tabs: [],
        client:
          watches.current.get(key)?.client ?? createFileWatchClient(() => env),
      };
      group.tabs.push(tab);
      next.set(key, group);
    }
    for (const key of new Set([...next.keys(), ...watches.current.keys()])) {
      const before = watches.current.get(key);
      const after = next.get(key);
      const group = after ?? before;
      if (!group) continue;
      const prev = fileWatchTargets(before?.tabs ?? []);
      const want = fileWatchTargets(after?.tabs ?? []);
      group.client.add(
        [...want.dirs].filter((p) => !prev.dirs.has(p)),
        [...want.files].filter((p) => !prev.files.has(p)),
      );
      group.client.remove(
        [...prev.dirs].filter((p) => !want.dirs.has(p)),
        [...prev.files].filter((p) => !want.files.has(p)),
      );
    }
    watches.current = next;
  }, [tabs, spaces]);
  useEffect(
    () => () => {
      for (const { client } of watches.current.values()) client.dispose();
      watches.current.clear();
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
      for (const t of tabsRef.current) {
        if (t.kind !== "editor") continue;
        if (changed.has(t.path.replace(/\\/g, "/"))) {
          editorRefs.current.get(t.id)?.reload();
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [tabsRef, editorRefs]);
}
