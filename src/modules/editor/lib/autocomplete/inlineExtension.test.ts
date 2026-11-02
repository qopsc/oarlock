import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { completionPreferences } from "./preferences";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import {
  type EditorView,
  type PluginValue,
  ViewPlugin,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AutocompleteContext,
  inlineCompletion,
  refreshInlineCompletion,
  triggerInlineCompletion,
} from "./inlineExtension";
import { requestCompletion } from "./provider";

vi.mock("./provider", () => ({ requestCompletion: vi.fn() }));

const request = vi.mocked(requestCompletion);
const drivers: PluginValue[] = [];
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function editor(doc = "const result = ") {
  let prefs: ReturnType<AutocompleteContext["getPrefs"]> = {
    enabled: true,
    trigger: "auto",
    provider: "openai",
    modelId: "model-a",
    apiKey: "test-key",
    credentialStatus: "ready",
    lmstudioBaseURL: "",
  };
  let path = "/project/one.ts";
  let document: ReturnType<AutocompleteContext["getDocument"]> = {
    workspace: { kind: "local" },
    allowed: true,
  };
  const applied: string[] = [];
  const indent = new Compartment();
  const define = vi.spyOn(ViewPlugin, "define");
  const extension = inlineCompletion({
    getPrefs: () => prefs,
    getPath: () => path,
    getDocument: () => document,
    getLanguage: () => "typescript",
  });
  const create = define.mock.calls[0][0];
  define.mockRestore();
  let driver: PluginValue;
  const fakeView = {
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        extension,
        indent.of(indentUnit.of("  ")),
        EditorState.allowMultipleSelections.of(true),
      ],
    }),
    dispatch(spec: TransactionSpec) {
      const tr = this.state.update(spec);
      this.state = tr.state;
      for (const effect of tr.effects) {
        if (effect.value && typeof effect.value.text === "string")
          applied.push(effect.value.text);
      }
      driver.update?.({
        docChanged: tr.docChanged,
        selectionSet: tr.selection !== undefined,
        transactions: [tr],
      } as unknown as ViewUpdate);
    },
  };
  const view = fakeView as unknown as EditorView;
  driver = create(view, undefined);
  drivers.push(driver);
  return {
    view,
    applied,
    setDocument(next: typeof document) {
      document = next;
      refreshInlineCompletion(view);
    },
    setPrefs(patch: Partial<typeof prefs>) {
      prefs = { ...prefs, ...patch };
      refreshInlineCompletion(view);
    },
    setCurrentPreferences(patch: {
      hydrated?: boolean;
      syncing?: boolean;
      error?: string | null;
    }) {
      prefs = completionPreferences(
        {
          ...DEFAULT_PREFERENCES,
          autocompleteEnabled: true,
          autocompleteProvider: "openai",
          autocompleteModelId: "model-a",
          hydrated: true,
          syncing: false,
          error: null,
          ...patch,
        },
        {
          provider: "openai",
          modelId: "model-a",
          status: "ready",
          key: "test-key",
          endpoint: null,
        },
      );
      refreshInlineCompletion(view);
    },
    refreshKey() {
      refreshInlineCompletion(view, true);
    },
    accept(key = "Tab") {
      return view.state
        .facet(keymap)
        .flat()
        .find((binding) => binding.key === key)
        ?.run?.(view);
    },
    destroy() {
      driver.destroy?.();
    },
    setIndent(unit: string) {
      view.dispatch({ effects: indent.reconfigure(indentUnit.of(unit)) });
    },
    setPath(next: string) {
      path = next;
    },
    async trigger() {
      triggerInlineCompletion(view);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
});
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.destroy?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("inline completion request ownership", () => {
  it("drops an old response after a programmatic edit at the same cursor", async () => {
    const pending = deferred();
    request.mockReturnValue(pending.promise);
    const e = editor();
    await e.trigger();
    e.view.dispatch({ changes: { from: 0, to: 5, insert: "await" } });
    pending.resolve("compute()");
    await vi.advanceTimersByTimeAsync(0);
    expect(e.applied).toEqual([]);
    expect(request.mock.calls[0][2].aborted).toBe(true);
  });

  it.each([
    { enabled: false },
    { credentialStatus: "loading" as const },
    { credentialStatus: "failed" as const },
    { modelId: "model-b" },
    { apiKey: "replacement" },
    {
      provider: "openai-compatible" as const,
      openaiCompatibleBaseURL: "https://other.test/v1",
    },
  ])(
    "does not present an old response after preferences change: %j",
    async (patch) => {
      const pending = deferred();
      request.mockReturnValue(pending.promise);
      const e = editor();
      await e.trigger();
      e.setPrefs(patch);
      expect(request.mock.calls[0][2].aborted).toBe(true);
      pending.resolve("compute()");
      await vi.advanceTimersByTimeAsync(0);
      expect(e.applied).toEqual([]);
    },
  );

  it("clears visible text and cached results on disable, and does not restart on enable", async () => {
    request.mockResolvedValue("compute()");
    const e = editor();
    await e.trigger();
    e.setPrefs({ enabled: false });
    expect(e.accept()).toBe(false);
    e.setPrefs({ enabled: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(2);
    expect(e.accept()).toBe(true);
  });

  it("cancels a typing debounce when settings change", async () => {
    const e = editor();
    const end = e.view.state.doc.length;
    e.view.dispatch({
      changes: { from: end, insert: "n" },
      selection: { anchor: end + 1 },
      userEvent: "input.type",
    });
    e.setPrefs({ modelId: "model-b" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue("newValue()");
    await e.trigger();
    expect(request.mock.calls[0][1].modelId).toBe("model-b");
  });

  it("does not interrupt work for an unchanged completion configuration", async () => {
    const pending = deferred();
    request.mockReturnValue(pending.promise);
    const e = editor();
    await e.trigger();
    e.setPrefs({});
    expect(request.mock.calls[0][2].aborted).toBe(false);
    pending.resolve("compute()");
    await vi.advanceTimersByTimeAsync(0);
    e.setPrefs({});
    expect(e.accept()).toBe(true);
  });

  it("cancels key refresh immediately, including keyless requests, without reviving old responses", async () => {
    const pending = deferred();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce("newValue()");
    const e = editor();
    e.setPrefs({
      provider: "openai-compatible",
      apiKey: null,
      openaiCompatibleBaseURL: "https://server.test/v1",
    });
    await e.trigger();
    e.refreshKey();
    expect(request.mock.calls[0][2].aborted).toBe(true);
    e.setPrefs({ apiKey: "new-key" });
    await e.trigger();
    pending.resolve("obsolete()");
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.applied).toEqual(["newValue()"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ignores notifications and delayed results after editor teardown", async () => {
    const pending = deferred();
    request.mockReturnValue(pending.promise);
    const e = editor();
    await e.trigger();
    e.destroy();
    e.setPrefs({ modelId: "model-b" });
    pending.resolve("obsolete()");
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.applied).toEqual([]);
    expect(triggerInlineCompletion(e.view)).toBe(false);
  });

  it.each(["Tab", "Mod-ArrowRight"])(
    "%s refuses a ghost produced for the previous indentation",
    async (key) => {
      request.mockResolvedValue("compute()");
      const e = editor();
      await e.trigger();
      e.setIndent("\t");
      expect(e.accept(key)).toBe(false);
      expect(e.view.state.doc.toString()).toBe("const result = ");
    },
  );

  it.each(["Tab", "Mod-ArrowRight"])(
    "%s refuses a ghost after the file is renamed even before its notification",
    async (key) => {
      request.mockResolvedValue("compute()");
      const e = editor();
      await e.trigger();
      e.setPath("/project/other.ts");
      expect(e.accept(key)).toBe(false);
      expect(e.view.state.doc.toString()).toBe("const result = ");
    },
  );

  it("cancels pending work when the pane publishes updated indentation", async () => {
    const pending = deferred();
    request.mockReturnValue(pending.promise);
    const e = editor();
    await e.trigger();
    e.setIndent("\t");
    refreshInlineCompletion(e.view);
    expect(request.mock.calls[0][2].aborted).toBe(true);
    pending.resolve("oldIndent()");
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.applied).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not collapse multiple cursors into one with a single-cursor suggestion", async () => {
    request.mockResolvedValue("compute()");
    const e = editor();
    e.view.dispatch({
      selection: EditorSelection.create(
        [
          EditorSelection.cursor(0),
          EditorSelection.cursor(e.view.state.doc.length),
        ],
        1,
      ),
    });
    await e.trigger();
    expect(request).not.toHaveBeenCalled();
    expect(e.accept()).toBe(false);
    expect(e.view.state.selection.ranges).toHaveLength(2);
  });

  it("waits for explicit keyless readiness without automatically resuming", async () => {
    request.mockResolvedValue("compute()");
    const e = editor();
    e.setPrefs({
      provider: "openai-compatible",
      apiKey: null,
      credentialStatus: "loading",
      openaiCompatibleBaseURL: "https://server.test/v1",
    });
    await e.trigger();
    expect(request).not.toHaveBeenCalled();
    e.setPrefs({ credentialStatus: "keyless" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached text from another model", async () => {
    request.mockResolvedValueOnce("first()").mockResolvedValueOnce("second()");
    const e = editor();
    await e.trigger();
    e.setPrefs({ modelId: "model-b" });
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(2);
    expect(e.applied).toEqual(["first()", "second()"]);
  });

  it("does not reuse cached text after Save As changes the filename", async () => {
    request.mockResolvedValueOnce("first()").mockResolvedValueOnce("second()");
    const e = editor();
    await e.trigger();
    e.setPath("/project/two.ts");
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].filename).toBe("/project/two.ts");
  });

  it("invalidates context outside the old 512-character cache tail", async () => {
    request.mockResolvedValueOnce("first()").mockResolvedValueOnce("second()");
    const e = editor(
      `const mode = 1;\n${"// filler\n".repeat(70)}const result = `,
    );
    await e.trigger();
    e.view.dispatch({ changes: { from: 13, to: 14, insert: "2" } });
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(2);
    expect(e.applied).toEqual(["first()", "second()"]);
  });

  it("aborts before a new typing debounce expires", async () => {
    const pending = deferred();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce("newValue()");
    const e = editor();
    await e.trigger();
    const end = e.view.state.doc.length;
    e.view.dispatch({
      changes: { from: end, insert: "n" },
      selection: { anchor: end + 1 },
      userEvent: "input.type",
    });
    expect(request.mock.calls[0][2].aborted).toBe(true);
    pending.resolve("oldValue()");
    await vi.advanceTimersByTimeAsync(350);
    expect(request).toHaveBeenCalledTimes(2);
    expect(e.applied).toEqual(["ewValue()"]);
  });

  it("bounds cached prompt memory and keeps the most recently used entries", async () => {
    request.mockResolvedValue("compute()");
    const doc = `a${" ".repeat(3998)}`;
    const e = editor(doc);
    await e.trigger();
    // Nine full prompt identities exceed 64 KiB even before filling 32 slots.
    for (const letter of "bcdefghi") {
      e.view.dispatch({ changes: { from: 0, to: 1, insert: letter } });
      await e.trigger();
    }
    e.view.dispatch({ changes: { from: 0, to: 1, insert: "h" } });
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(9);
    e.view.dispatch({ changes: { from: 0, to: 1, insert: "a" } });
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(10);
  });

  it("reuses a cached suggestion for exactly the same request", async () => {
    request.mockResolvedValue("compute()");
    const e = editor();
    await e.trigger();
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(1);
    expect(e.applied).toEqual(["compute()", "compute()"]);
  });
});

it.each([{ hydrated: false }, { syncing: true }, { error: "read failed" }])(
  "current preference readiness aborts completions, discards late results and requires a fresh trigger: %j",
  async (patch) => {
    const pending = deferred();
    request.mockReturnValueOnce(pending.promise).mockResolvedValue("fresh()");
    const e = editor();
    e.setCurrentPreferences({});
    await e.trigger();
    const signal = request.mock.calls[0][2];
    e.setCurrentPreferences(patch);
    expect(signal.aborted).toBe(true);
    pending.resolve("obsolete()");
    await vi.advanceTimersByTimeAsync(0);
    expect(e.accept()).toBe(false);
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(1);
    e.setCurrentPreferences({});
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    await e.trigger();
    expect(request).toHaveBeenCalledTimes(2);
    expect(e.accept()).toBe(true);
  },
);
it("a preference synchronization failure clears visible autocomplete and cached results", async () => {
  request.mockResolvedValue("compute()");
  const e = editor();
  e.setCurrentPreferences({});
  await e.trigger();
  e.setCurrentPreferences({ error: "failed" });
  expect(e.accept()).toBe(false);
  e.setCurrentPreferences({});
  await e.trigger();
  expect(request).toHaveBeenCalledTimes(2);
});

it("cancels and clears suggestions when document eligibility or environment changes", async () => {
  const t = editor();
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  triggerInlineCompletion(t.view);
  await vi.advanceTimersByTimeAsync(0);
  const signal = request.mock.calls[0][2];
  t.setDocument({
    workspace: { kind: "wsl", distro: "Ubuntu" },
    allowed: false,
  });
  expect(signal.aborted).toBe(true);
  pending.resolve("old completion");
  await vi.advanceTimersByTimeAsync(0);
  expect(t.applied).toEqual([]);
  t.setDocument({
    workspace: { kind: "wsl", distro: "Debian" },
    allowed: true,
  });
  request.mockResolvedValueOnce("new completion");
  triggerInlineCompletion(t.view);
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.lastCall?.[0].document?.workspace).toEqual({
    kind: "wsl",
    distro: "Debian",
  });
});
