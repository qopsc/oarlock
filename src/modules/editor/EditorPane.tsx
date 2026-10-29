import {
  safeFindNext as findNext,
  safeFindPrevious as findPrevious,
} from "./search/regexView";
import { editorQuitExtension } from "./lib/quitExtension";
import { completionPreferences } from "./lib/autocomplete/preferences";
import type { CompletionCredential } from "./lib/autocomplete/credential";
import { useOwnedWorkspace } from "@/modules/workspace/owner";
import {
  workspaceEnvForPath,
  workspaceScopeKey,
} from "@/modules/workspace/env";
import type { MatchCount } from "@/lib/matchCount";
import { IS_MAC } from "@/lib/platform";
import { endpointIdFromCompatModel } from "@/modules/ai/config";
import { readCustomEndpointKey, readKey } from "@/modules/ai/lib/keyring";
import { createNative } from "@/modules/ai/lib/native";
import { lspFormatDocument, useLspExtension } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type EditorDefaultIndent,
  onKeysChanged,
} from "@/modules/settings/store";
import { openInDefaultApp } from "@/modules/explorer/lib/openDefault";
import { PrivacyRefusalNotice, usePrivacyRefusal } from "@/modules/mac-privacy";
import { useWorkspaceAssetUrl } from "@/modules/workspace";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import {
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import CodeMirror, {
  type ReactCodeMirrorProps,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import {
  forwardRef,
  memo,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  inlineCompletion,
  refreshInlineCompletion,
  triggerInlineCompletion,
} from "./lib/autocomplete/inlineExtension";
import { diagnosticsReporter } from "./lib/diagnosticsReporter";
import { useDiagnosticsStore } from "./lib/diagnosticsStore";
import { editorClaimedModKey, editorKeymap } from "./lib/editorKeymap";
import { normalizeToLf } from "./lib/eol";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  indentCompartment,
  indentExtension,
  languageCompartment,
  lspCompartment,
  vimCompartment,
  wordWrapExtension,
  wrapCompartment,
} from "./lib/extensions";
import { resolveFormatter, runExternalFormatter } from "./lib/externalFormat";
import { gitChangeGutter, setGitBase } from "./lib/gitGutter";
import { onHeadMoved } from "./lib/gitSignals";
import { defaultIndentUnit, detectIndentUnit } from "./lib/indent";
import {
  documentLanguage,
  parseFiletype,
  vimFiletype,
} from "./lib/documentLanguage";
import { resolveLanguage } from "./lib/languageResolver";
import { useDocumentLanguage } from "./lib/useDocumentLanguage";
import { mediaPreviewKind } from "./lib/mediaPreview";
import { SearchCountHub, searchCountHub } from "./lib/searchCount";
import { FORCE_READ_LIMIT, useDocument } from "./lib/useDocument";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { syncViewText } from "./lib/viewSync";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";
import { MediaPreview } from "./MediaPreview";

initVimGlobals();

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  /** Open CodeMirror's find/replace panel. */
  openSearch: () => void;
  /** Matches of the current find, counted only while someone subscribes. */
  searchCount: () => MatchCount | null;
  subscribeSearchCount: (listener: () => void) => () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /**
   * Re-read the file from disk. Skips silently if the buffer is dirty,
   * unless `force` (the user discarded those edits).
   */
  reload: (options?: { force?: boolean }) => boolean;
  /** Move the cursor to a 1-based line and center it, once content is ready. */
  gotoLine: (line: number, options?: { focus?: boolean }) => void;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
  /** Persist the buffer (format-on-save + write), same as Mod+S / :w. */
  save: () => Promise<boolean>;
  /** Synchronous buffer state; tab decorations may still be awaiting a render. */
  hasUnsavedChanges: () => boolean;
  closeRevision: () => string;
  prepareDiscard: () => import("./lib/documentSession").DiscardPreparation;
  detach: () => void;
  isDetached: () => boolean;
  /** Request an AI ghost suggestion at the cursor. */
  triggerAiComplete: () => void;
  /** Open CodeMirror's completion popup. */
  triggerCodeComplete: () => void;
};

type Props = {
  path: string;
  overrideLanguage?: string | null;
  onOverrideLanguage?: (language: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBindingChange?: (path: string, detached: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  mediaActive?: boolean;
};

// Above this, syntax highlighting and LSP are disabled: a multi-MB lezer
// parse tree and a didOpen of that size cost far more than they give.
const SYNTAX_MAX_BYTES = 4 * 1024 * 1024;
const reportLanguageFailure = (error: unknown) =>
  toast.error("Could not load document language", {
    description: String(error),
  });

// CodeMirror replaces its document whenever `value` changes identity, so a
// reload whose text equals the previous value never reached the view, and
// typing that landed before the commit was clobbered. It takes the text it
// mounts with; the pane pushes later text itself (syncViewText).
function MountedCodeMirror({
  initialValue,
  onDestroyEditor,
  ...props
}: Omit<ReactCodeMirrorProps, "value"> & {
  initialValue: string;
  onDestroyEditor: () => void;
  ref?: Ref<ReactCodeMirrorRef>;
}) {
  const [value] = useState(initialValue);
  useEffect(() => onDestroyEditor, [onDestroyEditor]);
  return <CodeMirror {...props} value={value} />;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// memo: EditorStack passes identity-stable props, so background editors
// skip re-rendering entirely when App re-renders (terminal events, tab churn).
export const EditorPane = memo(
  forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
    const owner = useOwnedWorkspace();
    const {
      path,
      overrideLanguage,
      onOverrideLanguage,
      onDirtyChange,
      onBindingChange,
      onSaved,
      onClose,
      mediaActive = true,
    } = props;

    const language = useMemo(
      () => documentLanguage(path, overrideLanguage),
      [path, overrideLanguage],
    );
    const workspace = workspaceEnvForPath(path, owner);
    const native = useMemo(() => createNative(() => workspace), [workspace]);
    const {
      doc,
      detached,
      detach,
      isDetached,
      recover,
      canComplete,
      onChange,
      save,
      isSaved,
      hasUnsavedChanges,
      closeRevision,
      prepareDiscard,
      reload,
      text,
      formatAndSave,
      openAnyway,
    } = useDocument({
      path,
      onDirtyChange,
      onBindingChange,
    });
    const [recoveryPath, setRecoveryPath] = useState<string | null>(null);
    const [recovering, setRecovering] = useState(false);
    const recoverDraft = async (target: string) => {
      if (recovering) return;
      if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(target)) {
        toast.error("Enter an absolute file path");
        return;
      }
      if (
        workspaceScopeKey(workspaceEnvForPath(target, owner)) !==
        workspaceScopeKey(workspace)
      ) {
        toast.error("Choose a path in this document's environment");
        return;
      }
      setRecovering(true);
      try {
        if (await recover(target)) setRecoveryPath(null);
      } finally {
        setRecovering(false);
      }
    };
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const formatAndSaveRef = useRef(formatAndSave);
    formatAndSaveRef.current = formatAndSave;
    const saveLifetime = useRef(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: changing document identity invalidates pending saves even when the view is reused.
    useLayoutEffect(() => {
      saveLifetime.current++;
      return () => {
        saveLifetime.current++;
      };
    }, [path, workspace, detached, language.id]);
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const [editorView, setEditorView] = useState<EditorView | null>(null);
    const handleDestroyEditor = useCallback(() => setEditorView(null), []);
    const completionDocument = useRef(() => ({
      workspace,
      allowed: canComplete(path),
    }));
    completionDocument.current = () => ({
      workspace,
      allowed: canComplete(path),
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: document replacement must cancel work even when its text is unchanged
    useLayoutEffect(() => {
      if (cmRef.current?.view)
        refreshInlineCompletion(cmRef.current.view, true);
    }, [path, workspace, doc, detached]);
    // Outlives the views the pane creates, so a subscriber keeps its count.
    const [searchCounts] = useState(() => new SearchCountHub());
    const themeExt = useEditorThemeExt();
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const wordWrapColumn = usePreferencesStore((s) =>
      s.editorWordWrap ? s.editorWordWrapColumn : null,
    );
    const languageRef = useRef<string | null>(language.id);
    languageRef.current = language.id;
    const langId = language.id;
    const languageChangeRef = useRef(onOverrideLanguage);
    languageChangeRef.current = onOverrideLanguage;
    const languageOverrideRef = useRef(overrideLanguage);
    languageOverrideRef.current = overrideLanguage;
    const changeFiletypeRef = useRef<(value: string) => void>(() => {});
    const apiKeyRef = useRef<CompletionCredential | null>(null);

    useEffect(() => {
      let cancelled = false;
      let generation = 0;
      let watching: "loading" | "ready" | "failed" = "loading";
      const refreshCompletion = (force = false) => {
        const view = cmRef.current?.view;
        if (view) refreshInlineCompletion(view, force);
      };
      const refresh = async () => {
        if (cancelled) return;
        const request = ++generation;
        const s = usePreferencesStore.getState();
        const provider = s.autocompleteProvider;
        const modelId = s.autocompleteModelId;
        apiKeyRef.current = {
          status: watching === "failed" ? "failed" : "loading",
          provider,
          modelId,
        };
        // Cancel before reading the keychain, even if a keyless request is live.
        refreshCompletion(true);
        if (watching !== "ready") return;
        try {
          const credential: CompletionCredential = {
            status: "ready",
            provider,
            modelId,
            key: null,
            endpoint: null,
          };
          if (provider === "openai-compatible") {
            const eid = endpointIdFromCompatModel(modelId);
            if (!eid) throw new Error("No custom endpoint selected");
            credential.endpoint = await readCustomEndpointKey(eid);
          } else {
            credential.key = await readKey(provider);
          }
          if (!cancelled && request === generation) {
            apiKeyRef.current = credential;
            refreshCompletion();
          }
        } catch {
          if (!cancelled && request === generation) {
            apiKeyRef.current = { status: "failed", provider, modelId };
            refreshCompletion();
            toast.error("Could not load autocomplete credentials", {
              description:
                "Turn autocomplete off and on in Settings → Models to retry.",
            });
          }
        }
      };
      let unlistenKeys: (() => void) | undefined;
      void onKeysChanged(() => void refresh())
        .then((un) => {
          if (cancelled) un();
          else {
            unlistenKeys = un;
            watching = "ready";
            void refresh();
          }
        })
        .catch((error) => {
          if (!cancelled) {
            watching = "failed";
            void refresh();
            toast.error("Could not watch API key changes", {
              description: `Reload this window to retry. ${String(error)}`,
            });
          }
        });
      const unsubPrefs = usePreferencesStore.subscribe((state, prev) => {
        if (
          state.autocompleteProvider !== prev.autocompleteProvider ||
          state.autocompleteModelId !== prev.autocompleteModelId ||
          (state.autocompleteEnabled && !prev.autocompleteEnabled)
        ) {
          void refresh();
        } else {
          // The driver compares only completion inputs; unrelated preferences
          // do not discard a suggestion or interrupt its request.
          refreshCompletion();
        }
      });
      return () => {
        cancelled = true;
        unlistenKeys?.();
        unsubPrefs();
      };
    }, []);
    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const isSavedRef = useRef(isSaved);
    isSavedRef.current = isSaved;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const lspActiveRef = useRef(false);
    changeFiletypeRef.current = (value) => {
      const next = parseFiletype(value);
      if (!languageChangeRef.current)
        throw Error("This document cannot change its language.");
      languageRef.current = documentLanguage(path, next).id;
      languageOverrideRef.current = next;
      saveLifetime.current++;
      lspActiveRef.current = false;
      languageChangeRef.current(next);
    };
    const warnedNoLspRef = useRef(false);
    const warnedNoFormatRef = useRef(false);

    const performSave = useCallback(async () => {
      if (isDetached()) return saveRef.current();
      const view = cmRef.current?.view;
      const lifetime = saveLifetime.current;
      const current = () =>
        saveLifetime.current === lifetime && cmRef.current?.view === view;
      const prefs = usePreferencesStore.getState();
      const formatter = resolveFormatter(languageRef.current, prefs);
      if (prefs.editorFormatOnSave && formatter !== "lsp") {
        try {
          const languageHint = languageOverrideRef.current
            ? (languageRef.current ?? "txt")
            : null;
          const saved = await formatAndSaveRef.current(
            async (file, content) => {
              const result = await runExternalFormatter(
                formatter,
                file,
                content,
                prefs.editorCustomFormatCommand,
                workspace,
                languageHint,
              );
              if (!current())
                throw Error(
                  "Document language changed during formatting. Save again.",
                );
              return result;
            },
          );
          if (saved && current()) onSavedRef.current?.();
          return saved && current();
        } catch (error) {
          if (current())
            toast.error(`${formatter} format failed; file not saved`, {
              description: String(error),
            });
        }
        return false;
      }
      if (prefs.editorFormatOnSave && formatter === "lsp" && view) {
        if (lspActiveRef.current) {
          let res: "done" | "unsupported" = "done";
          try {
            res = await lspFormatDocument(view, current);
          } catch (e) {
            toast.error("Language server format failed", {
              description: String(e),
            });
          }
          if (res === "unsupported" && !warnedNoFormatRef.current) {
            warnedNoFormatRef.current = true;
            toast.warning("Format on save skipped", {
              description:
                "The active language server has no formatter. Pick an external one in Settings (Ruff for Python, Prettier, rustfmt, ...).",
            });
          }
        } else if (!warnedNoLspRef.current) {
          warnedNoLspRef.current = true;
          toast.warning("Format on save skipped", {
            description:
              "No active language server for this file. Enable one in the statusbar, or pick an external formatter in Settings.",
          });
        }
      }
      if (!current()) return false;
      const saved = await saveRef.current();
      if (!saved || !current()) return false;
      onSavedRef.current?.();
      return true;
    }, [workspace, isDetached]);
    const performSaveRef = useRef(performSave);
    performSaveRef.current = performSave;

    const pathRef = useRef(path);
    pathRef.current = path;

    const pendingLineRef = useRef<{
      path: string;
      line: number;
      focus: boolean;
    } | null>(null);
    const pendingFocusRef = useRef<string | null>(null);
    const statusRef = useRef(doc.status);
    useLayoutEffect(() => {
      statusRef.current = doc.status;
    }, [doc.status]);

    useEffect(() => {
      if (pendingLineRef.current?.path !== path) {
        pendingLineRef.current = null;
      }
      if (pendingFocusRef.current !== path) {
        pendingFocusRef.current = null;
      }
    }, [path]);

    const focusWhenRendered = useCallback(
      (view: EditorView, targetPath: string) => {
        requestAnimationFrame(() => {
          if (cmRef.current?.view === view && pathRef.current === targetPath) {
            view.focus();
          }
        });
      },
      [],
    );

    const applyPendingGoto = useCallback(
      (view = cmRef.current?.view) => {
        const pending = pendingLineRef.current;
        if (!view || pending == null || statusRef.current !== "ready") return;
        if (pending.path !== path) {
          pendingLineRef.current = null;
          return;
        }
        const target = Math.max(
          1,
          Math.min(pending.line, view.state.doc.lines),
        );
        const at = view.state.doc.line(target).from;
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: "center" }),
        });
        if (pending.focus) focusWhenRendered(view, pending.path);
        pendingLineRef.current = null;
      },
      [focusWhenRendered, path],
    );

    const applyPendingFocus = useCallback(
      (view = cmRef.current?.view) => {
        const pendingPath = pendingFocusRef.current;
        if (!view || pendingPath === null || statusRef.current !== "ready")
          return;
        pendingFocusRef.current = null;
        if (pendingPath === path) focusWhenRendered(view, pendingPath);
      },
      [focusWhenRendered, path],
    );

    useEffect(() => {
      if (doc.status !== "ready") return;
      applyPendingGoto();
      applyPendingFocus();
    }, [doc.status, applyPendingFocus, applyPendingGoto]);

    const extensions = useMemo(
      () => [
        editorQuitExtension,
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        wrapCompartment.of(
          wordWrapExtension(
            usePreferencesStore.getState().editorWordWrap
              ? usePreferencesStore.getState().editorWordWrapColumn
              : null,
          ),
        ),
        vimHandlersExtension(() => ({
          save: () => performSaveRef.current(),
          identity: () => saveLifetime.current,
          canClose: () => isSavedRef.current(),
          close: () => onCloseRef.current?.(),
          filetype: {
            get: () => vimFiletype(languageRef.current),
            set: (value) => changeFiletypeRef.current(value),
          },
        })),
        ...buildSharedExtensions(),
        searchCountHub.of(searchCounts),
        indentCompartment.of(DEFAULT_INDENT),
        languageCompartment.of([]),
        lspCompartment.of([]),
        gitChangeGutter,
        diagnosticsReporter(() => pathRef.current),
        // Before inlineCompletion so an open popup wins Tab over the ghost.
        Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
        inlineCompletion({
          getPrefs: () =>
            completionPreferences(
              usePreferencesStore.getState(),
              apiKeyRef.current,
            ),
          getPath: () => pathRef.current,
          getDocument: () => completionDocument.current(),
          getLanguage: () => languageRef.current,
        }),
        editorKeymap(() => void performSaveRef.current()),
      ],
      [searchCounts],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(wordWrapExtension(wordWrapColumn)),
      });
    }, [wordWrapColumn]);

    // Shows text adopted from disk (reload, discard) before paint. text() is
    // the session's buffer, so anything typed since the read is kept.
    useLayoutEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (view) syncViewText(view, text());
    }, [doc, text]);

    // Detected from the buffer; the setting covers files with nothing to
    // detect (new or unindented).
    const editorDefaultIndent = usePreferencesStore(
      (s) => s.editorDefaultIndent,
    );
    const applyIndent = useCallback(
      (view: EditorView, setting: EditorDefaultIndent) => {
        const unit = detectIndentUnit(text(), defaultIndentUnit(setting));
        view.dispatch({
          effects: indentCompartment.reconfigure(indentExtension(unit)),
        });
        refreshInlineCompletion(view);
      },
      [text],
    );

    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (view) applyIndent(view, editorDefaultIndent);
    }, [doc, editorDefaultIndent, applyIndent]);

    // CodeMirror creates its view a few renders after the document turned
    // ready, after this pane's effects for that document already ran
    // without one: apply what they could not (indent unit, a pending go-to
    // line or focus from opening the file at a location).
    const handleCreateEditor = (view: EditorView) => {
      setEditorView(view);
      applyIndent(view, editorDefaultIndent);
      applyPendingGoto(view);
      applyPendingFocus(view);
    };

    // The change gutter's base is the committed text, fetched when the file
    // is (re)loaded, when the pane comes into view, and after a commit or
    // pull in Source Control. Hidden panes catch up when shown.
    const [headMoves, setHeadMoves] = useState(0);
    const mediaActiveRef = useRef(mediaActive);
    mediaActiveRef.current = mediaActive;
    useEffect(
      () =>
        onHeadMoved(() => {
          if (mediaActiveRef.current) setHeadMoves((n) => n + 1);
        }),
      [],
    );
    useEffect(() => {
      if (detached || doc.status !== "ready" || doc.size > SYNTAX_MAX_BYTES)
        return;
      if (!mediaActive) return;
      void headMoves;
      let cancelled = false;
      const apply = (base: string | null) => {
        if (cancelled) return;
        cmRef.current?.view?.dispatch({
          effects: setGitBase.of(base === null ? null : normalizeToLf(base)),
        });
      };
      native.gitFileBase(path).then(apply, () => apply(null));
      return () => {
        cancelled = true;
      };
    }, [doc, path, mediaActive, headMoves, native.gitFileBase, detached]);

    const syntaxReady = doc.status === "ready" && doc.size <= SYNTAX_MAX_BYTES;
    const lspExt = useLspExtension(path, langId, syntaxReady && !detached);
    useEffect(() => {
      lspActiveRef.current = lspExt !== null;
      if (!editorView || doc.status !== "ready") return;
      editorView.dispatch({
        effects: lspCompartment.reconfigure(lspExt ?? []),
      });
    }, [lspExt, editorView, doc.status]);

    useEffect(
      () => () => useDiagnosticsStore.getState().report(pathRef.current, null),
      [],
    );

    // Every consumer uses the same selected language id. Parser loading may be
    // asynchronous; never keep the previous language's parser while it loads.
    useEffect(() => {
      const source = overrideLanguage ? `dummy.${overrideLanguage}` : path;
      void resolveLanguage(source).catch(() => {});
    }, [path, overrideLanguage]);

    useDocumentLanguage(
      doc.status === "ready" ? editorView : null,
      overrideLanguage ? `dummy.${overrideLanguage}` : path,
      syntaxReady,
      languageCompartment,
      refreshInlineCompletion,
      reportLanguageFailure,
    );

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        openSearch: () => {
          const view = cmRef.current?.view;
          if (view) openSearchPanel(view);
        },
        searchCount: () => searchCounts.get(),
        subscribeSearchCount: (listener) => searchCounts.subscribe(listener),
        focus: () => {
          pendingFocusRef.current = path;
          applyPendingFocus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: (options) => reloadRef.current(options),
        gotoLine: (line: number, options) => {
          pendingLineRef.current = {
            path,
            line,
            focus: options?.focus ?? true,
          };
          applyPendingGoto();
        },
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
        save: () => performSaveRef.current(),
        hasUnsavedChanges,
        closeRevision,
        prepareDiscard,
        detach,
        isDetached,
        triggerAiComplete: () => {
          const view = cmRef.current?.view;
          if (view) triggerInlineCompletion(view);
        },
        triggerCodeComplete: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.focus();
          startCompletion(view);
        },
      }),
      [
        path,
        applyPendingFocus,
        applyPendingGoto,
        searchCounts,
        hasUnsavedChanges,
        closeRevision,
        prepareDiscard,
        detach,
        isDetached,
      ],
    );

    const mediaKind =
      doc.status === "binary" || doc.status === "toolarge"
        ? mediaPreviewKind(path)
        : null;
    const assetUrl = useWorkspaceAssetUrl(mediaKind ? path : null);
    const refusal = usePrivacyRefusal(
      path,
      doc.status === "error" ? doc.message : null,
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      if (refusal) {
        return (
          <PrivacyRefusalNotice
            refusal={refusal}
            title="Oarlock cannot open this file"
            className="h-full justify-center px-6"
          />
        );
      }
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary" || doc.status === "toolarge") {
      const kind = mediaKind;
      const isImage = kind === "image";
      const isPdf = kind === "pdf";

      if (kind) {
        // A WSL path is still being mapped to its host path.
        if (assetUrl === null) return null;
        return (
          <div className="flex h-full min-h-0 flex-col items-center justify-center bg-background p-4 overflow-auto">
            {isImage && (
              <img
                src={assetUrl}
                loading="lazy"
                decoding="async"
                className="max-w-full max-h-full object-contain rounded-md border border-border shadow-sm"
                style={{
                  backgroundImage:
                    "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
                  backgroundSize: "20px 20px",
                }}
                alt={path.split(/[\\/]/).pop()}
              />
            )}
            {(kind === "video" || kind === "audio") && (
              <MediaPreview kind={kind} src={assetUrl} active={mediaActive} />
            )}
            {isPdf && (
              <iframe
                src={assetUrl}
                className="w-full h-full border-none"
                title={path.split(/[\\/]/).pop()}
              />
            )}
          </div>
        );
      }

      const canForce =
        doc.status === "toolarge" && doc.size <= FORCE_READ_LIMIT;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">
            {doc.status === "binary" ? "Binary file" : "File too large"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} ·{" "}
            {canForce ? "syntax features disabled" : "preview not supported"}
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {canForce && (
              <button
                type="button"
                onClick={openAnyway}
                className="rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
              >
                Open anyway
              </button>
            )}
            <button
              type="button"
              onClick={() => void openInDefaultApp(path)}
              className="rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              Open in Default App
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="flex h-full min-h-0 flex-col zoom-exempt"
        data-claims-mod-key={editorClaimedModKey(IS_MAC)}
      >
        {detached && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-xs"
          >
            <span>
              File deleted. This draft is detached; automatic saves are paused.
            </span>
            <button
              type="button"
              disabled={recovering}
              className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              onClick={() => void recoverDraft(path)}
            >
              Restore file
            </button>
            <button
              type="button"
              disabled={recovering}
              className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
              onClick={() => setRecoveryPath(path)}
            >
              Save As…
            </button>
            {recoveryPath !== null && (
              <form
                className="flex w-full gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void recoverDraft(recoveryPath);
                }}
              >
                <input
                  aria-label="Save draft as"
                  className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
                  value={recoveryPath}
                  onChange={(event) => setRecoveryPath(event.target.value)}
                />
                <button
                  type="submit"
                  disabled={recovering}
                  className="rounded border px-2 py-1"
                >
                  Save
                </button>
                <button type="button" onClick={() => setRecoveryPath(null)}>
                  Cancel
                </button>
              </form>
            )}
          </div>
        )}
        <MountedCodeMirror
          ref={cmRef}
          initialValue={doc.content}
          onCreateEditor={handleCreateEditor}
          onDestroyEditor={handleDestroyEditor}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="oarlock-code-editor flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            searchKeymap: true,
          }}
        />
      </div>
    );
  }),
);
