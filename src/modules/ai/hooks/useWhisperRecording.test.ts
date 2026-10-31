import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => {
  function store(initial: Record<string, unknown>) {
    let state = initial;
    const listeners = new Set<(state: Record<string, unknown>) => void>();
    return Object.assign(
      (select: (state: Record<string, unknown>) => unknown) => select(state),
      {
        getState: () => state,
        subscribe: (cb: (state: Record<string, unknown>) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        setState: (patch: Record<string, unknown>) => {
          state = { ...state, ...patch };
          for (const cb of [...listeners]) cb(state);
        },
        listeners,
      },
    );
  }
  return {
    effects: [] as (() => () => void)[],
    admission: vi.fn(),
    transcribe: vi.fn(),
    getMedia: vi.fn(),
    stopTrack: vi.fn(),
    result: vi.fn(),
    chat: store({}),
    preferences: store({}),
    spaces: store({}),
    env: store({}),
  };
});
vi.mock("react", () => ({
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => () => void) => fake.effects.push(fn),
}));
vi.mock("../store/chatStop", () => ({ assertChatCanStart: fake.admission }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../store/chatStore", () => ({ useChatStore: fake.chat }));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({ useSpaces: fake.spaces }));
vi.mock("@/modules/workspace/env", () => ({
  useWorkspaceEnvStore: fake.env,
  workspaceScopeKey: (env: unknown) => JSON.stringify(env),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: fake.preferences,
}));
vi.mock("../lib/stt", () => ({ transcribeAudio: fake.transcribe }));
import { useWhisperRecording } from "./useWhisperRecording";
class Recorder {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (e: { data: Blob }) => void;
  onstop?: () => void;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}
beforeEach(() => {
  fake.effects = [];
  vi.clearAllMocks();
  fake.admission.mockReset().mockResolvedValue(undefined);
  fake.chat.setState({
    activeSessionId: "a",
    panelOpen: true,
    apiKeys: { openai: "key" },
  });
  fake.preferences.setState({
    hydrated: true,
    syncing: false,
    error: null,
    sttProvider: "openai",
    groqSttModel: "whisper-large-v3-turbo",
    whispercppBaseURL: "http://127.0.0.1:8080",
  });
  fake.spaces.setState({ activeId: "one" });
  fake.env.setState({ env: { kind: "local" } });
  fake.getMedia.mockResolvedValue({
    getTracks: () => [{ stop: fake.stopTrack }],
  });
  fake.transcribe.mockResolvedValue("transcript");
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: fake.getMedia } });
});
afterEach(() => vi.unstubAllGlobals());
it.each(["chat", "space", "environment", "panel", "unmount"])(
  "%s changes cancel voice and remove active-only subscriptions",
  async (change) => {
    const voice = useWhisperRecording({ onResult: fake.result });
    const cleanup = fake.effects[0]();
    voice.setVisible(true);
    expect(fake.chat.listeners.size).toBe(0);
    await voice.start();
    expect(fake.chat.listeners.size).toBe(1);
    if (change === "chat") fake.chat.setState({ activeSessionId: "b" });
    if (change === "space") fake.spaces.setState({ activeId: "two" });
    if (change === "environment")
      fake.env.setState({ env: { kind: "wsl", distro: "Ubuntu" } });
    if (change === "panel") fake.chat.setState({ panelOpen: false });
    if (change === "unmount") cleanup();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.transcribe).not.toHaveBeenCalled();
    expect(fake.result).not.toHaveBeenCalled();
    expect(fake.stopTrack).toHaveBeenCalledOnce();
    expect(
      fake.chat.listeners.size +
        fake.spaces.listeners.size +
        fake.env.listeners.size +
        fake.preferences.listeners.size,
    ).toBe(0);
    cleanup();
  },
);

it("Stop during native admission prevents a late microphone request", async () => {
  let admit!: () => void;
  fake.admission.mockReturnValue(
    new Promise<void>((r) => {
      admit = r;
    }),
  );
  const voice = useWhisperRecording({ onResult: fake.result });
  const cleanup = fake.effects[0]();
  voice.setVisible(true);
  const start = voice.start();
  voice.cancel();
  admit();
  await start;
  expect(fake.getMedia).not.toHaveBeenCalled();
  expect(
    fake.chat.listeners.size +
      fake.spaces.listeners.size +
      fake.env.listeners.size +
      fake.preferences.listeners.size,
  ).toBe(0);
  cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const configurationChanges = [
  {
    name: "preference revision gap",
    provider: "openai",
    change: () => fake.preferences.setState({ syncing: true }),
  },
  {
    name: "preference read failure",
    provider: "openai",
    change: () => fake.preferences.setState({ error: "read failed" }),
  },
  {
    name: "provider",
    provider: "openai",
    change: () => fake.preferences.setState({ sttProvider: "whispercpp" }),
  },
  {
    name: "Groq model",
    provider: "groq",
    change: () =>
      fake.preferences.setState({ groqSttModel: "whisper-large-v3" }),
  },
  {
    name: "local URL",
    provider: "whispercpp",
    change: () =>
      fake.preferences.setState({ whispercppBaseURL: "http://127.0.0.1:9090" }),
  },
  {
    name: "key replacement",
    provider: "openai",
    change: () => fake.chat.setState({ apiKeys: { openai: "replacement" } }),
  },
  {
    name: "key removal",
    provider: "openai",
    change: () => fake.chat.setState({ apiKeys: { openai: null } }),
  },
  {
    name: "key loading",
    provider: "groq",
    change: () =>
      fake.chat.setState({ apiKeys: { groq: { status: "loading" } } }),
  },
  {
    name: "key failure",
    provider: "openai",
    change: () =>
      fake.chat.setState({
        apiKeys: { openai: { status: "failed", error: "locked" } },
      }),
  },
];
for (const phase of ["admission", "permission", "recording", "transcribing"]) {
  it.each(configurationChanges)(
    `${phase}: $name cancels owned voice work`,
    async ({ provider, change }) => {
      fake.preferences.setState({ sttProvider: provider });
      fake.chat.setState({ apiKeys: { openai: "key", groq: "groq-key" } });
      const admission = deferred<void>();
      const microphone = deferred<{
        getTracks: () => { stop: typeof fake.stopTrack }[];
      }>();
      const transcript = deferred<string>();
      if (phase === "admission")
        fake.admission.mockReturnValue(admission.promise);
      if (phase === "permission")
        fake.getMedia.mockReturnValue(microphone.promise);
      fake.transcribe.mockReturnValue(transcript.promise);
      const voice = useWhisperRecording({ onResult: fake.result });
      voice.setVisible(true);
      const starting = voice.start();
      await tick();
      if (phase === "transcribing") voice.stop();
      expect(voice.busy()).toBe(true);
      expect(fake.preferences.listeners.size).toBe(1);
      change();
      expect(voice.busy()).toBe(false);
      voice.stop(); // A stale microphone button cannot submit cancelled audio.
      if (phase === "transcribing") {
        expect(fake.transcribe.mock.calls[0][3].signal.aborted).toBe(true);
      } else {
        expect(fake.transcribe).not.toHaveBeenCalled();
      }
      admission.resolve();
      microphone.resolve({ getTracks: () => [{ stop: fake.stopTrack }] });
      transcript.resolve("stale transcript");
      await starting;
      await tick();
      expect(fake.result).not.toHaveBeenCalled();
      expect(fake.stopTrack).toHaveBeenCalledTimes(
        phase === "admission" ? 0 : 1,
      );
      if (phase === "admission") expect(fake.getMedia).not.toHaveBeenCalled();
      expect(
        fake.preferences.listeners.size +
          fake.chat.listeners.size +
          fake.spaces.listeners.size +
          fake.env.listeners.size,
      ).toBe(0);
    },
  );
}

it.each(["openai", "groq", "whispercpp"])(
  "%s ignores unrelated settings and credentials",
  async (provider) => {
    fake.preferences.setState({ sttProvider: provider });
    fake.chat.setState({ apiKeys: { openai: "key", groq: "groq-key" } });
    const voice = useWhisperRecording({ onResult: fake.result });
    voice.setVisible(true);
    await voice.start();
    fake.preferences.setState({ theme: "dark" });
    if (provider !== "groq")
      fake.preferences.setState({ groqSttModel: "other-model" });
    if (provider !== "whispercpp")
      fake.preferences.setState({ whispercppBaseURL: "http://localhost:9999" });
    fake.chat.setState({
      apiKeys: {
        openai: provider === "openai" ? "key" : "new-key",
        groq: provider === "groq" ? "groq-key" : null,
      },
    });
    expect(voice.busy()).toBe(true);
    voice.stop();
    await tick();
    expect(fake.result).toHaveBeenCalledWith("transcript");
    expect(fake.preferences.listeners.size).toBe(0);
  },
);

it("Start uses current settings and credentials even before the next render", async () => {
  const voice = useWhisperRecording({ onResult: fake.result });
  voice.setVisible(true);
  fake.preferences.setState({
    sttProvider: "groq",
    groqSttModel: "whisper-large-v3",
  });
  const keys = { groq: "fresh-key" };
  fake.chat.setState({ apiKeys: keys });
  await voice.start();
  voice.stop();
  await tick();
  expect(fake.transcribe).toHaveBeenCalledWith(
    expect.any(Blob),
    "groq",
    keys,
    expect.objectContaining({
      groqSttModel: "whisper-large-v3",
      signal: expect.any(AbortSignal),
    }),
  );
});

it("a stale Start cannot acquire the microphone after its credential becomes unavailable", async () => {
  const voice = useWhisperRecording({ onResult: fake.result });
  voice.setVisible(true);
  fake.chat.setState({ apiKeys: { openai: { status: "loading" } } });
  await voice.start();
  expect(fake.getMedia).not.toHaveBeenCalled();
  expect(voice.busy()).toBe(false);
  expect(fake.preferences.listeners.size).toBe(0);
});

it("does not start voice before preferences are ready, even with a valid default-provider key", async () => {
  const voice = useWhisperRecording({ onResult: fake.result });
  voice.setVisible(true);
  fake.preferences.setState({ hydrated: false });
  await voice.start();
  expect(fake.getMedia).not.toHaveBeenCalled();
});
