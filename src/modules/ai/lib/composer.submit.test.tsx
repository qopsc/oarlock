import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  clipboard: vi.fn(),
  voiceState: "idle",
  voiceBusy: (): boolean => false,
  voiceResult: (_text: string) => {},
  chatListeners: new Set<() => void>(),
  spaceListeners: new Set<() => void>(),
  envListeners: new Set<() => void>(),
  space: { activeId: "space-a" },
  env: { env: { kind: "local" } },
  cells: [] as unknown[],
  index: 0,
  stop: vi.fn(async () => {}),
  send: vi.fn(
    async (_chat: unknown, _message: unknown, accepted?: () => void) => {
      accepted?.();
    },
  ),
  skill: vi.fn(),
  admission: vi.fn(async () => {}),
  state: {
    activeSessionId: "chat",
    panelOpen: true,
    focusInput: vi.fn(),
    agentMeta: { status: "idle" },
    focusSignal: 0,
    pendingSelections: [],
    mini: { open: true },
    live: { getWorkspaceRoot: () => "/a" },
    patchAgentMeta: vi.fn(),
    openMini: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("./pastedImages", () => ({ readClipboardSnapshot: fake.clipboard }));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const index = fake.index++;
    if (!(index in fake.cells)) fake.cells[index] = initial;
    return [
      fake.cells[index],
      (value: unknown) => {
        fake.cells[index] =
          typeof value === "function" ? value(fake.cells[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = fake.index++;
    if (!(index in fake.cells)) fake.cells[index] = { current: initial };
    return fake.cells[index];
  },
  useEffect: () => {},
  useEffectEvent: (fn: unknown) => fn,
}));
vi.mock("../store/chatStore", () => ({
  useChatStore: Object.assign(
    (select: (s: typeof fake.state) => unknown) => select(fake.state),
    {
      getState: () => ({ ...fake.state, stopSession: fake.stop }),
      subscribe: (fn: (state: typeof fake.state) => void) => {
        const listener = () => fn(fake.state);
        fake.chatListeners.add(listener);
        return () => fake.chatListeners.delete(listener);
      },
    },
  ),
}));
vi.mock("../store/chatStop", () => ({
  assertChatCanStart: fake.admission,
  useChatStop: Object.assign(
    (select: (s: { states: object }) => unknown) => select({ states: {} }),
    { getState: () => ({ states: {} }) },
  ),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) =>
    select({ hydrated: true, syncing: false, error: null }),
}));
vi.mock("../store/chatRuntime", () => ({
  getOrCreateChat: (id: string) => ({ id }),
  sendUserMessage: fake.send,
}));
vi.mock("../store/snippetsStore", () => ({
  useSnippetsStore: { getState: () => ({ snippets: [] }) },
}));
vi.mock("../hooks/useWhisperRecording", () => ({
  useWhisperRecording: (options: { onResult: (text: string) => void }) => {
    fake.voiceResult = options.onResult;
    return { state: fake.voiceState, busy: () => fake.voiceBusy() };
  },
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => fake.env.env,
  authorizeFileFolder: vi.fn(),
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: {
    getState: () => fake.space,
    subscribe: (fn: (state: typeof fake.space) => void) => {
      const listener = () => fn(fake.space);
      fake.spaceListeners.add(listener);
      return () => fake.spaceListeners.delete(listener);
    },
  },
}));
vi.mock("@/modules/workspace/env", () => ({
  workspaceScopeKey: (env: { kind: string }) => env.kind,
  useWorkspaceEnvStore: {
    subscribe: (fn: (state: typeof fake.env) => void) => {
      const listener = () => fn(fake.env);
      fake.envListeners.add(listener);
      return () => fake.envListeners.delete(listener);
    },
  },
}));
vi.mock("@/modules/skills/composer", () => ({ skillInvocation: fake.skill }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { AiComposerProvider, type useComposer } from "./composer";
import { SLASH_COMMANDS } from "./slashCommands";
function render() {
  fake.index = 0;
  return (
    AiComposerProvider({ children: null }) as ReactElement<{
      value: ReturnType<typeof useComposer>;
    }>
  ).props.value;
}
afterEach(async () => {
  const { cancelComposerWork } = await import("./composerWork");
  cancelComposerWork("chat");
});
beforeEach(() => {
  fake.voiceState = "idle";
  fake.voiceBusy = () => false;
  fake.state.activeSessionId = "chat";
  fake.state.panelOpen = true;
  fake.invoke.mockReset();
  fake.clipboard.mockReset();
  fake.space.activeId = "space-a";
  fake.env.env = { kind: "local" };
  fake.cells = [];
  fake.index = 0;
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    fn();
    return 1;
  });
});
it("consumes a picked Stop command so the following message is sent normally", async () => {
  render().addCommand(SLASH_COMMANDS.stop);
  render().submit();
  expect(fake.stop).toHaveBeenCalledOnce();
  expect(render().pickedCommands).toEqual([]);
  render().setValue("continue reviewing");
  render().submit();
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
  expect(fake.stop).toHaveBeenCalledOnce();
});

it("does not submit a prepared skill after the user has stopped the chat", async () => {
  let finish!: (value: { kind: "block"; block: string }) => void;
  fake.skill.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render().setValue("/slow review");
  render().submit();
  await vi.waitFor(() => expect(fake.skill).toHaveBeenCalledOnce());
  expect(render().isBusy).toBe(true);
  expect(render().canSend).toBe(false);
  render().stop();
  expect(render().isBusy).toBe(false);
  await fake.stop.mock.results[0].value;
  finish({ kind: "block", block: "skill instructions" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fake.send).not.toHaveBeenCalled();
});

it.each(["chat", "space", "env"] as const)(
  "navigation of %s cancels preparation, including switching back before it finishes",
  async (kind) => {
    let finish!: (value: { kind: "block"; block: string }) => void;
    fake.skill.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render().setValue("/slow original draft");
    render().submit();
    await vi.waitFor(() => expect(fake.skill).toHaveBeenCalledOnce());
    if (kind === "chat") {
      fake.state.activeSessionId = "other";
      for (const listener of [...fake.chatListeners]) listener();
      fake.state.activeSessionId = "chat";
      fake.state.panelOpen = true;
      fake.invoke.mockReset();
      fake.clipboard.mockReset();
    } else if (kind === "space") {
      fake.space.activeId = "other";
      for (const listener of [...fake.spaceListeners]) listener();
      fake.space.activeId = "space-a";
    } else {
      fake.env.env = { kind: "wsl" };
      for (const listener of [...fake.envListeners]) listener();
      fake.env.env = { kind: "local" };
    }
    finish({ kind: "block", block: "late instructions" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.send).not.toHaveBeenCalled();
    expect(render().value).toBe("/slow original draft");
    expect(
      fake.chatListeners.size +
        fake.spaceListeners.size +
        fake.envListeners.size,
    ).toBe(0);
    render().setValue("new message");
    render().submit();
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
  },
);
it("accepts /stop while preparation is waiting", async () => {
  let finish!: (value: { kind: "missing" }) => void;
  fake.skill.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render().setValue("/slow");
  render().submit();
  await vi.waitFor(() => expect(fake.skill).toHaveBeenCalledOnce());
  render().setValue("/stop");
  render().submit();
  expect(fake.stop).toHaveBeenCalledOnce();
  finish({ kind: "missing" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fake.send).not.toHaveBeenCalled();
});

it("Stop also cancels a plain message waiting for its lazy transport import", async () => {
  render().setValue("ordinary draft");
  render().submit();
  render().stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fake.send).not.toHaveBeenCalled();
  expect(render().value).toBe("ordinary draft");
});
it("an old cancelled preparation cannot unlock a newer pending submission", async () => {
  const finishes: ((value: { kind: "missing" }) => void)[] = [];
  fake.skill.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(resolve);
      }),
  );
  render().setValue("/first");
  render().submit();
  await vi.waitFor(() => expect(finishes).toHaveLength(1));
  render().stop();
  render().setValue("/second");
  render().submit();
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  finishes[0]({ kind: "missing" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  render().submit();
  expect(fake.skill).toHaveBeenCalledTimes(2);
  finishes[1]({ kind: "missing" });
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
  fake.skill.mockReset();
});

it("registers for shared Stop before beginning async preparation", async () => {
  let admit!: () => void;
  fake.admission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        admit = resolve;
      }),
  );
  render().setValue("/slow");
  render().submit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fake.admission).toHaveBeenCalledWith("chat");
  expect(fake.skill).not.toHaveBeenCalled();
  const { cancelComposerWork } = await import("./composerWork");
  cancelComposerWork("chat");
  admit();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fake.skill).not.toHaveBeenCalled();
  expect(fake.send).not.toHaveBeenCalled();
  expect(render().value).toBe("/slow");
});

it.each(["stop", "chat", "space", "environment", "close"])(
  "%s discards a late native import while preserving completed draft content",
  async (event) => {
    let finish!: (value: object) => void;
    fake.invoke.mockImplementation((command) =>
      command === "ai_import_attachment"
        ? new Promise((r) => {
            finish = r;
          })
        : Promise.resolve([]),
    );
    render().setValue("keep my draft");
    const prior = render().beginImport()!;
    render().attachFiles(
      [
        {
          id: "done",
          name: "done.txt",
          kind: "text",
          mediaType: "text/plain",
          text: "complete",
          size: 8,
        },
      ],
      prior,
    );
    prior.finish();
    const reading = render().attachFileByPath("/repo/a.md");
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled());
    if (event === "stop") render().stop();
    if (event === "chat") {
      fake.state.activeSessionId = "other";
      for (const fn of fake.chatListeners) fn();
    }
    if (event === "space") {
      fake.space.activeId = "other";
      for (const fn of fake.spaceListeners) fn();
    }
    if (event === "environment") {
      fake.env.env = { kind: "other" };
      for (const fn of fake.envListeners) fn();
    }
    if (event === "close") {
      fake.state.panelOpen = false;
      for (const fn of fake.chatListeners) fn();
    }
    finish({ kind: "text", name: "a.md", content: "late", size: 4 });
    await reading;
    expect(render().files.map((f) => f.id)).toEqual(["done"]);
    expect(render().value).toBe("keep my draft");
    expect(
      fake.chatListeners.size +
        fake.spaceListeners.size +
        fake.envListeners.size,
    ).toBe(0);
  },
);
it("a cancelled picker never imports its late selections", async () => {
  let finish!: (paths: string[]) => void;
  fake.invoke.mockReturnValue(
    new Promise((r) => {
      finish = r;
    }),
  );
  const picking = render().pickFiles();
  await vi.waitFor(() =>
    expect(fake.invoke).toHaveBeenCalledWith("ai_pick_attachment_files"),
  );
  render().cancelImports();
  finish(["/repo/.env"]);
  await picking;
  expect(fake.invoke).toHaveBeenCalledOnce();
  expect(render().files).toEqual([]);
});
it("a host picker imports via the native boundary and skips a refused file without stopping the batch", async () => {
  fake.invoke.mockImplementation(async (command, args) => {
    if (command === "ai_pick_attachment_files")
      return ["/repo/.env", "/repo/readme.md"];
    if (args.path.endsWith(".env"))
      throw new Error("Refused: sensitive attachment");
    return { kind: "text", name: "readme.md", content: "safe", size: 4 };
  });
  await render().pickFiles();
  expect(render().files.map((f) => f.name)).toEqual(["readme.md"]);
  expect(
    fake.invoke.mock.calls.slice(1).map((call) => call[1].workspace),
  ).toEqual([{ kind: "local" }, { kind: "local" }]);
});
it("clipboard file paths cross native validation instead of falling back to clipboard pixels", async () => {
  fake.clipboard.mockResolvedValue({ kind: "files", paths: ["/repo/.env"] });
  fake.invoke.mockImplementation(async () => {
    throw new Error("sensitive");
  });
  await render().pasteClipboardImage();
  expect(fake.clipboard).toHaveBeenCalledOnce();
  expect(render().files).toEqual([]);
});
it("cancelled clipboard image loading cannot append an image", async () => {
  fake.invoke.mockResolvedValue([]);
  let finish!: (image: { kind: string; image: File }) => void;
  fake.clipboard.mockReturnValue(
    new Promise((r) => {
      finish = r;
    }),
  );
  const loading = render().pasteClipboardImage();
  await vi.waitFor(() => expect(fake.clipboard).toHaveBeenCalled());
  render().stop();
  finish({
    kind: "image",
    image: new File(["png"], "image.png", { type: "image/png" }),
  });
  await loading;
  expect(render().files).toEqual([]);
});

it("blocks Send immediately and includes the attachment when sent after import completes", async () => {
  let finish!: (value: object) => void;
  fake.invoke.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  render().setValue("review the attached file");
  const composer = render();
  const reading = composer.attachFileByPath("/repo/notes.md");
  // A handler captured before React commits the busy state must also be blocked.
  composer.submit();
  expect(render().isBusy).toBe(true);
  expect(render().canSend).toBe(false);
  await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled());
  expect(fake.send).not.toHaveBeenCalled();
  render().submit();
  finish({
    kind: "text",
    name: "notes.md",
    content: "expected attachment",
    size: 19,
  });
  await reading;
  expect(fake.send).not.toHaveBeenCalled();
  expect(render().isBusy).toBe(false);
  expect(render().canSend).toBe(true);
  render().submit();
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
  expect(JSON.stringify(fake.send.mock.calls[0][1])).toContain(
    "expected attachment",
  );
  expect(render().files).toEqual([]);
});

it("keeps Send blocked through a picker and every file in its batch", async () => {
  let pick!: (paths: string[]) => void;
  const reads: ((value: object) => void)[] = [];
  fake.invoke.mockImplementation((command) =>
    command === "ai_pick_attachment_files"
      ? new Promise((r) => {
          pick = r;
        })
      : new Promise((r) => {
          reads.push(r);
        }),
  );
  render().setValue("review both");
  const picking = render().pickFiles();
  expect(render().isBusy).toBe(true);
  await vi.waitFor(() => expect(pick).toBeDefined());
  pick(["/repo/first.txt", "/repo/last.txt"]);
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  reads[0]({ kind: "text", name: "first.txt", content: "first", size: 5 });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(render().files).toHaveLength(1);
  expect(render().isBusy).toBe(true);
  render().submit();
  expect(fake.send).not.toHaveBeenCalled();
  reads[1]({ kind: "text", name: "last.txt", content: "last", size: 4 });
  await picking;
  expect(render().files).toHaveLength(2);
  expect(render().canSend).toBe(true);
});

it("Stop releases the import barrier and a cancelled late result cannot release a newer import", async () => {
  const reads: ((value: object) => void)[] = [];
  fake.invoke.mockImplementation(
    () =>
      new Promise((r) => {
        reads.push(r);
      }),
  );
  render().setValue("keep draft");
  const first = render().attachFileByPath("/repo/first.txt");
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  render().stop();
  expect(fake.stop).toHaveBeenCalledOnce();
  expect(render().isBusy).toBe(false);
  expect(render().value).toBe("keep draft");
  const next = render().attachFileByPath("/repo/next.txt");
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  reads[0]({ kind: "text", name: "first.txt", content: "late", size: 4 });
  await first;
  expect(render().isBusy).toBe(true);
  expect(render().files).toEqual([]);
  reads[1]({ kind: "text", name: "next.txt", content: "new", size: 3 });
  await next;
  expect(render().canSend).toBe(true);
  expect(render().files.map((f) => f.text)).toEqual(["new"]);
});

it("failed imports release Send without consuming the draft", async () => {
  fake.invoke.mockRejectedValue(new Error("Refused: sensitive path"));
  render().setValue("keep draft");
  const reading = render().attachFileByPath("/repo/.env");
  expect(render().canSend).toBe(false);
  await reading;
  expect(render().isBusy).toBe(false);
  expect(render().canSend).toBe(true);
  expect(render().value).toBe("keep draft");
});

it("captures the clipboard at paste start while admission is pending, and never re-reads", async () => {
  let admit!: () => void;
  fake.admission.mockImplementationOnce(
    () =>
      new Promise((r) => {
        admit = r;
      }),
  );
  fake.clipboard.mockResolvedValue({
    kind: "files",
    paths: ["/repo/original.txt"],
  });
  fake.invoke.mockResolvedValue({
    kind: "text",
    name: "original.txt",
    content: "original",
    size: 8,
  });
  const reading = render().pasteClipboardImage();
  expect(fake.clipboard).toHaveBeenCalledOnce();
  expect(fake.invoke).not.toHaveBeenCalled();
  fake.clipboard.mockResolvedValue({
    kind: "files",
    paths: ["/repo/changed.txt"],
  });
  admit();
  await reading;
  expect(fake.clipboard).toHaveBeenCalledOnce();
  expect(fake.invoke).toHaveBeenCalledWith(
    "ai_import_attachment",
    expect.objectContaining({ path: "/repo/original.txt" }),
  );
});
it("a changed clipboard releases the barrier and preserves the draft without fallback", async () => {
  fake.clipboard.mockRejectedValue(new Error("Clipboard changed"));
  render().setValue("keep this");
  await render().pasteClipboardImage();
  expect(fake.invoke).not.toHaveBeenCalled();
  expect(render().files).toEqual([]);
  expect(render().value).toBe("keep this");
  expect(render().canSend).toBe(true);
});
it("voice blocks Send before rendering and throughout acquisition, recording and transcription", async () => {
  const { createVoiceRecording } = await import("./voiceRecording");
  const { beginComposerWork } = await import("./composerWork");
  let finish!: (text: string) => void;
  const recorder = {
    state: "inactive",
    mimeType: "audio/webm",
    ondataavailable: null as null | ((event: { data: Blob }) => void),
    onstop: null as null | (() => void),
    onerror: null,
    start() {
      this.state = "recording";
    },
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      this.onstop?.();
    },
  };
  const voice = createVoiceRecording({
    acquire: async () =>
      ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
    recorder: () => recorder as unknown as MediaRecorder,
    state: (state) => {
      fake.voiceState = state;
    },
    error: (error) => {
      throw error;
    },
  });
  fake.voiceBusy = voice.busy;
  render().setValue("review this");
  const before = render();
  voice.setVisible(true);
  const start = voice.start({
    begin: () => beginComposerWork("chat"),
    transcribe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    result: (text) => fake.voiceResult(text),
  });
  before.submit();
  expect(fake.voiceState).toBe("acquiring");
  expect(render().isBusy).toBe(true);
  await start;
  expect(fake.voiceState).toBe("recording");
  expect(render().canSend).toBe(false);
  render().submit();
  voice.stop();
  expect(fake.voiceState).toBe("transcribing");
  expect(render().canSend).toBe(false);
  render().submit();
  expect(fake.send).not.toHaveBeenCalled();
  finish("my dictation");
  await vi.waitFor(() => expect(fake.voiceState).toBe("idle"));
  expect(render().value).toBe("review this my dictation");
  expect(render().canSend).toBe(true);
  expect(fake.send).not.toHaveBeenCalled();
  render().submit();
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
  expect(JSON.stringify(fake.send.mock.calls[0][1])).toContain(
    "review this my dictation",
  );
});
