import { WorkspaceOwner } from "@/modules/workspace/owner";
import { LOCAL_WORKSPACE } from "@/modules/workspace/env";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { cn, isMarkdownPath } from "@/lib/utils";
import { MarkdownViewToggle } from "@/modules/markdown";
import { useWindowInactive } from "@/modules/theme/WindowActivityBridge";
import type { EditorTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOverrideLanguage?: (id: number, language: string | null) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onBindingChange?: (id: number, path: string, detached: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
};

export function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  onOverrideLanguage,
  onBindingChange,
  registerHandle,
  onCloseTab,
  onSetMarkdownView,
}: Props) {
  const spaces = useSpaces((s) => s.spaces);
  const editors = tabs.filter(
    (t): t is EditorTab => t.kind === "editor" && !t.cold,
  );

  // Stable per-tab callbacks. Inline arrows in `ref` and `onDirtyChange`
  // change identity every render, which makes React detach+reattach the ref
  // callback and re-invoke `onDirtyChange`, triggering setState loops in
  // the parent. Memoizing per id keeps each callback's identity stable.
  const languageRef = useRef(onOverrideLanguage);
  languageRef.current = onOverrideLanguage;
  const languageCallbacks = useRef(new Map<number,(value:string|null)=>void>());
  const getLanguageCallback = (id:number) => {
    let callback=languageCallbacks.current.get(id);
    if(!callback){callback=value=>languageRef.current?.(id,value);languageCallbacks.current.set(id,callback);}
    return callback;
  };
  const registerRef = useRef(registerHandle);
  const bindingRef = useRef(onBindingChange);
  bindingRef.current = onBindingChange;
  const bindingCallbacks = useRef(
    new Map<number, (path: string, detached: boolean) => void>(),
  );
  const getBindingCallback = (id: number) => {
    let callback = bindingCallbacks.current.get(id);
    if (!callback) {
      callback = (path, detached) => bindingRef.current?.(id, path, detached);
      bindingCallbacks.current.set(id, callback);
    }
    return callback;
  };
  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onCloseTab);

  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onCloseTab;
  }, [onCloseTab]);

  const refCallbacks = useRef(
    new Map<number, (h: EditorPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useRef(new Map<number, (dirty: boolean) => void>());
  const closeCallbacks = useRef(new Map<number, () => void>());

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: EditorPaneHandle | null) => registerRef.current(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getDirtyCallback = (id: number) => {
    let cb = dirtyCallbacks.current.get(id);
    if (!cb) {
      cb = (dirty: boolean) => dirtyRef.current(id, dirty);
      dirtyCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getCloseCallback = (id: number) => {
    let cb = closeCallbacks.current.get(id);
    if (!cb) {
      cb = () => closeRef.current(id);
      closeCallbacks.current.set(id, cb);
    }
    return cb;
  };

  // Drop callback entries for closed tabs to avoid unbounded growth.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const id of languageCallbacks.current.keys()) if (!live.has(id)) languageCallbacks.current.delete(id);
    for (const id of bindingCallbacks.current.keys()) {
      if (!live.has(id)) bindingCallbacks.current.delete(id);
    }
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of dirtyCallbacks.current.keys()) {
      if (!live.has(id)) dirtyCallbacks.current.delete(id);
    }
    for (const id of closeCallbacks.current.keys()) {
      if (!live.has(id)) closeCallbacks.current.delete(id);
    }
  }, [editors]);

  const windowInactive = useWindowInactive();

  if (editors.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {editors.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <div className="relative h-full overflow-hidden bg-background">
              {isMarkdownPath(t.path) && (
                <MarkdownViewToggle
                  mode="raw"
                  onChange={(mode) => onSetMarkdownView(t.id, mode)}
                  renderedDisabled={t.dirty}
                  renderedHint="Save to preview"
                />
              )}
              <WorkspaceOwner
                env={
                  spaces.find((s) => s.id === t.spaceId)?.env ?? LOCAL_WORKSPACE
                }
              >
                <EditorPane
                  ref={getRefCallback(t.id)}
                  path={t.path}
                  overrideLanguage={t.overrideLanguage}
                  onOverrideLanguage={getLanguageCallback(t.id)}
                  onDirtyChange={getDirtyCallback(t.id)}
                  onBindingChange={getBindingCallback(t.id)}
                  onClose={getCloseCallback(t.id)}
                  mediaActive={visible && !windowInactive}
                />
              </WorkspaceOwner>
            </div>
          </div>
        );
      })}
    </div>
  );
}
