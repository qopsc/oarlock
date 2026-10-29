import { preferencesReady } from "@/modules/settings/readiness";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { createComposerImports, type ComposerImport } from "./composerImports";
import {
  beginComposerWork,
  cancelComposerWork,
  type ComposerWork,
} from "./composerWork";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import {
  useWorkspaceEnvStore,
  workspaceScopeKey,
} from "@/modules/workspace/env";
import { assertChatCanStart, useChatStop } from "../store/chatStop";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import {
  COMPOSER_DROP_EVENT,
  type DroppedPath,
  folderReference,
  insertIntoPrompt,
  planComposerDrop,
} from "./composerDrop";
import { encodeForSending, imageNeedsEncoding } from "./imageAttachment";
import { fileBlock, selectionBlock, snippetBlock } from "./messageBlocks";
import { readClipboardSnapshot } from "./pastedImages";
import {
  attachmentName,
  MAX_TEXT_ATTACHMENT_BYTES,
  readDroppedFile,
  readPickedFile,
  textTooLarge,
} from "./pathAttachment";
import type { ArgumentsFormRequest } from "@/modules/mcp/lib/argumentsForm";
import { parseMcpPromptInvocation } from "@/modules/mcp/slash";
import { parseSkillInvocation } from "@/modules/skills/slash";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  SLASH_COMMANDS,
  tryRunSlashCommand,
  type SlashCommandMeta,
} from "./slashCommands";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
  /** Read from an MCP server's resource: shown as that server's. */
  mcp?: { server: string; uri: string };
  /** The block it sends instead of a `<file>` one (an MCP resource's). */
  block?: string;
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

type Voice = ReturnType<typeof useWhisperRecording>;

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  pickFiles: () => Promise<void>;
  beginImport: () => ComposerImport | null;
  cancelImports: () => void;
  /** Attach the clipboard's image as the app reads it (a paste the webview
   *  handed no image, `pasteNeedsClipboardImage`). */
  pasteClipboardImage: () => Promise<void>;
  /** Attach a file by absolute path — used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  /** Attach prepared attachments (MCP resources); one already attached is kept once. */
  attachFiles: (files: readonly FileAttachment[], work: ComposerImport) => void;
  /** The open form of an MCP prompt or resource template, if any. */
  mcpForm: ArgumentsFormRequest | null;
  setMcpForm: React.Dispatch<React.SetStateAction<ArgumentsFormRequest | null>>;
  removeFile: (id: string) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  submit: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type Submission = ComposerWork & { admission: Promise<void> };

type ProviderProps = {
  children: React.ReactNode;
};

export function AiComposerProvider({ children }: ProviderProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const stopping = useChatStop((s) =>
    sessionId ? s.states[sessionId]?.blocked === true : false,
  );
  const [preparingSubmission, setPreparingSubmission] = useState(false);
  const [importing, setImporting] = useState(false);
  const turnBusy =
    preparingSubmission ||
    stopping ||
    status === "thinking" ||
    status === "streaming";

  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const [mcpForm, setMcpForm] = useState<ArgumentsFormRequest | null>(null);
  useEffect(() => () => mcpForm?.cancel(), [mcpForm]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Re-focus the textarea whenever the agent finishes a response
  const prevTurnBusyRef = useRef(false);
  useEffect(() => {
    if (prevTurnBusyRef.current && !turnBusy) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    prevTurnBusyRef.current = turnBusy;
  }, [turnBusy, textareaRef]);

  const attachFromExplorer = useEffectEvent((path: string) => {
    void attachFileByPath(path);
  });
  // Listen for explorer's "Attach to Agent" event.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) {
        attachFromExplorer(path);
      }
    };
    window.addEventListener("oarlock:ai-attach-file", onAttach);
    return () => window.removeEventListener("oarlock:ai-attach-file", onAttach);
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor" ? "Editor selection" : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });
  const isBusy = importing || turnBusy || voice.state !== "idle";

  const importsRef = useRef<ReturnType<typeof createComposerImports> | null>(
    null,
  );
  if (!importsRef.current)
    importsRef.current = createComposerImports(setImporting);
  const imports = importsRef.current;
  useEffect(() => () => imports.cancel(), [imports]);
  const beginImport = (): ComposerImport | null => {
    const chat = useChatStore.getState();
    if (!chat.activeSessionId) return null;
    const work = imports.begin(chat.activeSessionId, currentWorkspaceEnv());
    const chatId = chat.activeSessionId;
    const space = useSpaces.getState().activeId;
    const env = workspaceScopeKey(work.workspace);
    work.onFinish(
      useChatStore.subscribe((next) => {
        if (
          next.activeSessionId !== chatId ||
          (chat.panelOpen && !next.panelOpen)
        )
          work.cancel();
      }),
    );
    work.onFinish(
      useSpaces.subscribe((next) => {
        if (next.activeId !== space) work.cancel();
      }),
    );
    work.onFinish(
      useWorkspaceEnvStore.subscribe((next) => {
        if (workspaceScopeKey(next.env) !== env) work.cancel();
      }),
    );
    const admission = assertChatCanStart(chatId);
    void admission.catch(() => {});
    return Object.assign(work, { admission });
  };
  const attachFiles = (
    added: readonly FileAttachment[],
    work: ComposerImport,
  ) => {
    if (!work.active()) return;
    setFiles((prev) => {
      const ids = new Set(prev.map((f) => f.id));
      const next = added.filter((f) => !ids.has(f.id));
      return next.length > 0 ? [...prev, ...next] : prev;
    });
  };
  const runImport = async (action: (work: ComposerImport) => Promise<void>) => {
    const work = beginImport();
    if (!work) return;
    try {
      await work.admission;
      if (work.active()) await action(work);
    } catch (error) {
      if (work.active())
        toast.error("Could not attach content", { description: String(error) });
    } finally {
      work.finish();
    }
  };
  const importPath = async (
    path: string,
    picked: boolean,
    work: ComposerImport,
    workspace = work.workspace,
  ) => {
    if (!work.active()) return;
    try {
      const result = await (picked
        ? readPickedFile(path, workspace)
        : readDroppedFile(path, workspace));
      if (!work.active()) return;
      const id = `path-${workspaceScopeKey(workspace)}-${path}`;
      if (result.kind === "text") {
        attachFiles(
          [
            {
              id,
              name: result.name,
              kind: "text",
              mediaType: "text/plain",
              text: result.content,
              size: result.size,
            },
          ],
          work,
        );
      } else {
        const bytes = Uint8Array.from(atob(result.data), (c) =>
          c.charCodeAt(0),
        );
        const attachment = await readAttachment(
          new File([bytes], result.name, { type: result.media_type }),
          work.signal,
        );
        if (attachment) attachFiles([{ ...attachment, id }], work);
      }
    } catch (error) {
      if (work.active())
        toast.error(`Could not attach ${attachmentName(path)}`, {
          description: String(error),
        });
    }
  };
  const pickFiles = () =>
    runImport(async (work) => {
      const paths = await invoke<string[]>("ai_pick_attachment_files");
      for (const path of paths) {
        if (!work.active()) break;
        await importPath(path, true, work, { kind: "local" });
      }
    });
  const pasteClipboardImage = async () => {
    const work = beginImport();
    if (!work) return;
    try {
      // Capture at paste start, not after asynchronous chat admission.
      const [snapshot] = await Promise.all([
        readClipboardSnapshot(),
        work.admission,
      ]);
      if (!work.active()) return;
      if (snapshot.kind === "files") {
        for (const path of snapshot.paths) {
          if (!work.active()) break;
          await importPath(path, true, work, { kind: "local" });
        }
        return;
      }
      if (snapshot.kind === "empty") return;
      const attachment = await readAttachment(snapshot.image, work.signal);
      if (attachment) attachFiles([attachment], work);
    } catch (error) {
      if (work.active())
        toast.error("Could not paste attachment", {
          description: String(error),
        });
    } finally {
      work.finish();
    }
  };
  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) =>
      prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd],
    );
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  // Picked by the user (Attach to Agent, an @ mention) or dropped from the
  // explorer, which reads only what the agent itself may read.
  const attachFileByPath = async (path: string) => {
    useChatStore.getState().focusInput();
    await runImport((work) => importPath(path, true, work));
  };

  // Explorer items dropped on the composer: folders are named at the caret
  // (or at the end), files attach one by one.
  const onDropPaths = useEffectEvent(async (entries: DroppedPath[]) => {
    const { files, folders } = planComposerDrop(entries);
    if (folders.length > 0) {
      const el = textareaRef.current;
      const selection =
        el && document.activeElement === el
          ? { start: el.selectionStart, end: el.selectionEnd }
          : null;
      const next = insertIntoPrompt(
        value,
        selection,
        folders.map(folderReference).join(" "),
      );
      setValue(next.value);
      useChatStore.getState().focusInput();
      requestAnimationFrame(() =>
        textareaRef.current?.setSelectionRange(next.caret, next.caret),
      );
    }
    await runImport(async (work) => {
      for (const path of files) {
        if (!work.active()) break;
        await importPath(path, false, work);
      }
    });
  });
  useEffect(() => {
    const onDrop = (e: Event) => {
      const entries = (e as CustomEvent<DroppedPath[]>).detail;
      if (Array.isArray(entries)) void onDropPaths(entries);
    };
    window.addEventListener(COMPOSER_DROP_EVENT, onDrop);
    return () => window.removeEventListener(COMPOSER_DROP_EVENT, onDrop);
  }, []);

  // A skill or an MCP prompt is loaded (an MCP prompt's arguments asked for)
  // before its message is sent; nothing else is sent meanwhile.
  const preparing = useRef(false);
  const sending = useRef(false);
  const submission = useRef<Submission | null>(null);
  useEffect(() => () => submission.current?.cancel(), []);
  const beginSubmission = (): Submission | null => {
    if (!sessionId || useChatStore.getState().activeSessionId !== sessionId)
      return null;
    const admission = assertChatCanStart(sessionId);
    void admission.catch(() => {});
    const work = Object.assign(beginComposerWork(sessionId), { admission });
    submission.current = work;
    setPreparingSubmission(true);
    const space = useSpaces.getState().activeId;
    const env = workspaceScopeKey(currentWorkspaceEnv());
    work.onFinish(
      useChatStore.subscribe((state) => {
        if (state.activeSessionId !== sessionId) work.cancel();
      }),
    );
    work.onFinish(
      useSpaces.subscribe((state) => {
        if (state.activeId !== space) work.cancel();
      }),
    );
    work.onFinish(
      useWorkspaceEnvStore.subscribe((state) => {
        if (workspaceScopeKey(state.env) !== env) work.cancel();
      }),
    );
    work.onFinish(() => {
      if (submission.current !== work) return;
      submission.current = null;
      setPreparingSubmission(false);
      preparing.current = false;
      sending.current = false;
    });
    return work;
  };
  const consumeCommand = (source: string) => {
    setValue("");
    const handledName = source.slice(1).split(/\s/, 1)[0];
    setPickedCommands((current) =>
      current.filter((item) => item.name !== handledName),
    );
  };

  const submit = () => {
    const trimmed = value.trim();
    const commandSource =
      pickedCommands.length > 0 &&
      !trimmed.startsWith("/") &&
      !trimmed.startsWith("#")
        ? `#${pickedCommands[0].name} ${trimmed}`.trim()
        : trimmed;
    if (/^[/#]stop(?:\s|$)/.test(commandSource)) {
      cancelComposerWork(sessionId ?? "");
      tryRunSlashCommand(commandSource);
      consumeCommand(commandSource);
      return;
    }
    if (
      imports.busy() ||
      voice.busy() ||
      isBusy ||
      preparing.current ||
      sending.current
    )
      return;
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    // `/server:prompt ...` (typed, or picked as a chip) sends the MCP
    // prompt's messages with the user's text, after its form if it takes
    // arguments. A typed one no running server offers is sent as written.
    const pickedPrompt = pickedCommands.find((c) => c.prompt);
    const typedPrompt = pickedPrompt ? null : parseMcpPromptInvocation(trimmed);
    const promptCall = pickedPrompt
      ? { command: pickedPrompt.name, text: trimmed }
      : typedPrompt;
    if (promptCall) {
      const work = beginSubmission();
      if (!work) return;
      preparing.current = true;
      void work.admission
        .then(async () => {
          work.signal.throwIfAborted();
          return import("@/modules/mcp/composer");
        })
        .then(({ runPromptCall }) => {
          work.signal.throwIfAborted();
          return runPromptCall({
            signal: work.signal,
            command: promptCall.command,
            picked: pickedPrompt !== undefined,
            showForm: (form) => {
              if (work.signal.aborted) {
                form.cancel();
                return;
              }
              setMcpForm(form);
              work.onFinish(() => {
                form.cancel();
                setMcpForm((current) => (current === form ? null : current));
              });
            },
            send: (block, images) =>
              send(work, promptCall.text, null, [block], images),
            sendAsWritten: () => send(work, trimmed, null, []),
          });
        })
        .catch((error) => {
          if (!work.signal.aborted)
            toast.error("Could not prepare prompt", {
              description: String(error),
            });
        })
        .finally(work.finish);
      return;
    }

    // `/skill-name ...` (typed, or picked as a chip) sends the skill's
    // instructions with the user's text. Built-in commands keep their names.
    const pickedSkill = pickedCommands.find((c) => c.skill);
    const typedSkill = pickedSkill ? null : parseSkillInvocation(trimmed);
    const skillCall = pickedSkill
      ? { name: pickedSkill.name, args: trimmed }
      : typedSkill && !SLASH_COMMANDS[typedSkill.name]
        ? typedSkill
        : null;
    if (skillCall) {
      const work = beginSubmission();
      if (!work) return;
      const root = useChatStore.getState().live.getWorkspaceRoot();
      const env = currentWorkspaceEnv();
      preparing.current = true;
      void (async () => {
        try {
          await work.admission;
          work.signal.throwIfAborted();
          const { skillInvocation } = await import("@/modules/skills/composer");
          work.signal.throwIfAborted();
          const result = await skillInvocation(
            skillCall.name,
            skillCall.args,
            root,
            env,
          );
          work.signal.throwIfAborted();
          if (result.kind === "block") {
            await send(work, skillCall.args, null, [result.block]);
          } else if (pickedSkill) {
            toast.error(`The skill ${skillCall.name} is not available`);
          } else {
            await send(work, trimmed, null, []);
          }
        } catch (e) {
          if (work.signal.aborted) return;
          toast.error(`Could not load the skill ${skillCall.name}`, {
            description: e instanceof Error ? e.message : String(e),
          });
        } finally {
          work.finish();
        }
      })();
      return;
    }

    // Slash-command interception. `/plan` toggles plan mode; `/init` rewrites
    // the prompt to the AGENTS.md scan template before sending.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    if (commandSource.startsWith("/") || commandSource.startsWith("#")) {
      const outcome = tryRunSlashCommand(commandSource);
      if (outcome.kind === "handled") {
        consumeCommand(commandSource);
        if (outcome.toast) console.info(outcome.toast);
        return;
      }
      if (outcome.kind === "send-prompt") {
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<oarlock-command name="${outcome.commandName}" />`;
        }
      }
    }
    const work = beginSubmission();
    if (work) void send(work, effectiveText, commandMarker, []);
  };

  /** Sends the message: the command marker, `leading` blocks (a skill's or an
   *  MCP prompt's, whose images come as `leadingImages`), snippets, selections
   *  and files, then the text. */
  const send = async (
    work: Submission,
    effectiveText: string,
    commandMarker: string | null,
    leading: string[],
    leadingImages: readonly { mediaType: string; data: string }[] = [],
  ) => {
    if (work.signal.aborted) return;
    const parts: MessagePart[] = [];
    const fileBlocks = files.flatMap((f) =>
      f.block
        ? [f.block]
        : f.kind === "text"
          ? [fileBlock(f.name, f.mediaType, f.text ?? "")]
          : [],
    );
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map((f) => selectionBlock(f.source ?? "terminal", f.text ?? ""));
    const { body: bodyAfterTokens, blocks: snippetBlocks } =
      expandSnippetTokens(effectiveText, useSnippetsStore.getState().snippets);
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(snippetBlock(s.handle, s.content));
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      commandMarker ?? "",
      ...leading,
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (composed) parts.push({ type: "text", text: composed });

    for (const image of leadingImages) {
      parts.push({
        type: "file",
        mediaType: image.mediaType,
        url: `data:${image.mediaType};base64,${image.data}`,
      });
    }

    for (const f of files) {
      if (f.kind === "image" && f.url) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    if (!sessionId || useChatStop.getState().states[sessionId]?.blocked) {
      work.finish();
      return;
    }
    const store = useChatStore.getState();
    store.patchAgentMeta({ hitStepCap: false, compactionNotice: null });
    if (!store.mini.open) store.openMini();
    if (sending.current) {
      work.finish();
      return;
    }
    sending.current = true;
    let accepted = false;
    const pending = (async () => {
      await work.admission;
      work.signal.throwIfAborted();
      const { getOrCreateChat, sendUserMessage } = await import(
        "../store/chatRuntime"
      );
      work.signal.throwIfAborted();
      const chat = getOrCreateChat(sessionId);
      await sendUserMessage(
        chat,
        { role: "user", parts } as Parameters<typeof chat.sendMessage>[0],
        () => {
          accepted = true;
          work.finish();
          // A Stop rejection keeps the entire draft. Edits made while admission
          // was pending belong to the next draft and must not be discarded.
          setValue((current) => (current === value ? "" : current));
          setFiles((current) =>
            current.filter((item) => !files.includes(item)),
          );
          setPickedSnippets((current) =>
            current.filter((item) => !pickedSnippets.includes(item)),
          );
          setPickedCommands((current) =>
            current.filter((item) => !pickedCommands.includes(item)),
          );
        },
      );
    })()
      .catch((error) => {
        if (work.signal.aborted) return;
        toast.error("Could not send message", { description: String(error) });
      })
      .finally(() => {
        if (!accepted) work.finish();
      });
    // Re-focus immediately after submit so the user can type a follow-up
    requestAnimationFrame(() => textareaRef.current?.focus());
    await pending;
  };

  const stop = () => {
    if (!sessionId) return;
    cancelComposerWork(sessionId);
    useChatStore.getState().stopSession(sessionId);
  };

  const ready = usePreferencesStore(preferencesReady);
  const canSend =
    ready &&
    !isBusy &&
    (value.trim().length > 0 ||
      files.length > 0 ||
      pickedSnippets.length > 0 ||
      pickedCommands.length > 0);

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    pickFiles,
    beginImport,
    cancelImports: imports.cancel,
    pasteClipboardImage,
    attachFileByPath,
    attachFiles,
    mcpForm,
    setMcpForm,
    removeFile,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    pickedCommands,
    addCommand,
    removeCommand,
    isBusy,
    submit,
    stop,
    voice,
    canSend,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

/** A picked or pasted file as an attachment; null (said in a toast) when it
 *  cannot be one. */
async function readAttachment(
  file: File,
  signal: AbortSignal,
): Promise<FileAttachment | null> {
  signal.throwIfAborted();
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  const name = file.name || "image";
  if (file.type.startsWith("image/")) {
    const image = imageNeedsEncoding(file.type, file.size)
      ? await encodeForSending(file, signal)
      : file;
    signal.throwIfAborted();
    if (!image) {
      toast.error(`Could not attach ${name}`, {
        description:
          "The AI takes PNG, JPEG, GIF and WebP images, and this one could not be converted or made small enough.",
      });
      return null;
    }
    signal.throwIfAborted();
    const url = await readAsDataURL(image, signal);
    return {
      id,
      name: image.name,
      kind: "image",
      mediaType: image.type,
      url,
      size: image.size,
    };
  }
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    toast.error(`Could not attach ${name}`, {
      description: textTooLarge(file.size),
    });
    return null;
  }
  const text = await file.text();
  signal.throwIfAborted();
  return {
    id,
    name: file.name,
    kind: "text",
    mediaType: file.type || "text/plain",
    text,
    size: file.size,
  };
}

function readAsDataURL(file: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reader.abort();
      reject(signal.reason);
    };
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    reader.onload = () => {
      if (!signal.aborted) resolve(String(reader.result ?? ""));
    };
    reader.onerror = () => reject(reader.error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    reader.readAsDataURL(file);
  });
}
