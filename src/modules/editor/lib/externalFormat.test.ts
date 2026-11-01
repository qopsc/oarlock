import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: () => void = () => {};
  },
}));

vi.mock("@tauri-apps/api/core", () => core);
vi.mock("@/lib/networkPage", () => ({ networkPage: async () => "page" }));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => "local",
}));

import { resolveFormatter, runExternalFormatter } from "./externalFormat";

const prefs = (
  global: Parameters<typeof resolveFormatter>[1]["editorFormatter"],
  byLang: Record<string, never> | Record<string, "ruff" | "prettier"> = {},
) => ({ editorFormatter: global, editorFormatterByLang: byLang });

describe("resolveFormatter", () => {
  it("explicit override wins over the global default", () => {
    expect(resolveFormatter("py", prefs("biome", { py: "ruff" }))).toBe("ruff");
  });

  it("global external applies only to languages it understands", () => {
    expect(resolveFormatter("ts", prefs("biome"))).toBe("biome");
    expect(resolveFormatter("py", prefs("biome"))).toBe("lsp");
    expect(resolveFormatter("rs", prefs("prettier"))).toBe("lsp");
    expect(resolveFormatter("svelte", prefs("prettier"))).toBe("prettier");
  });

  it("lsp and custom globals always apply", () => {
    expect(resolveFormatter("py", prefs("lsp"))).toBe("lsp");
    expect(resolveFormatter("py", prefs("custom"))).toBe("custom");
  });

  it("unknown language falls back to lsp for external globals", () => {
    expect(resolveFormatter(null, prefs("biome"))).toBe("lsp");
  });
});

describe("runExternalFormatter", () => {
  beforeEach(() => {
    core.invoke.mockReset();
  });
  it("passes candidate input and returns text without writing or reading the document", async () => {
    core.invoke.mockResolvedValue({ content: "formatted", size: 9 });
    await expect(
      runExternalFormatter("rustfmt", "/repo/a.rs", "draft"),
    ).resolves.toEqual({ content: "formatted", size: 9 });
    expect(core.invoke.mock.calls).toEqual([
      [
        "fs_format_document",
        {
          formatter: "rustfmt",
          path: "/repo/a.rs",
          content: "draft",
          customCommand: "",
          workspace: "local",
          pageGeneration: "page",
          requestId: expect.any(String),
          onAdmitted: expect.any(core.Channel),
        },
      ],
    ]);
  });
  it("surfaces native rejection without trying a legacy in-place fallback", async () => {
    core.invoke.mockRejectedValue(new Error("unsupported in-place command"));
    await expect(
      runExternalFormatter("custom", "/a", "draft", "tool --write {file}"),
    ).rejects.toThrow("unsupported in-place");
    expect(core.invoke).toHaveBeenCalledTimes(1);
  });
  it("retries cancellation when it overtakes native admission", async () => {
    let complete!: (value: { content: string; size: number }) => void;
    core.invoke.mockImplementation((command: string) =>
      command === "fs_format_document"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(),
    );
    const owner = new AbortController();
    const request = runExternalFormatter(
      "rustfmt",
      "/a",
      "draft",
      "",
      { kind: "local" },
      null,
      owner.signal,
    );
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledOnce());
    const admitted = core.invoke.mock.calls[0][1].onAdmitted as InstanceType<
      typeof core.Channel
    >;
    owner.abort();
    await expect(request).rejects.toBe(owner.signal.reason);
    expect(
      core.invoke.mock.calls.filter(
        ([command]) => command === "fs_format_cancel",
      ),
    ).toHaveLength(1);
    admitted.onmessage();
    expect(
      core.invoke.mock.calls.filter(
        ([command]) => command === "fs_format_cancel",
      ),
    ).toHaveLength(2);
    complete({ content: "stale", size: 5 });
  });
  it("never cancels a newer formatter when an old admission arrives late", async () => {
    const finish: Array<(value: { content: string; size: number }) => void> =
      [];
    core.invoke.mockImplementation((command: string) =>
      command === "fs_format_document"
        ? new Promise((resolve) => {
            finish.push(resolve);
          })
        : Promise.resolve(),
    );
    const old = new AbortController();
    const oldRequest = runExternalFormatter(
      "rustfmt",
      "/a",
      "old",
      "",
      { kind: "local" },
      null,
      old.signal,
    );
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    const oldArgs = core.invoke.mock.calls[0][1];
    old.abort();
    await expect(oldRequest).rejects.toBe(old.signal.reason);
    const newer = runExternalFormatter("rustfmt", "/a", "new", "", {
      kind: "local",
    });
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    const newArgs = core.invoke.mock.calls.find(
      ([command, args]) =>
        command === "fs_format_document" && args.content === "new",
    )?.[1];
    oldArgs.onAdmitted.onmessage();
    const cancelledIds = core.invoke.mock.calls
      .filter(([command]) => command === "fs_format_cancel")
      .map(([, args]) => args.requestId);
    expect(cancelledIds).toEqual([oldArgs.requestId, oldArgs.requestId]);
    expect(newArgs.requestId).not.toBe(oldArgs.requestId);
    finish[1]({ content: "new", size: 3 });
    await expect(newer).resolves.toEqual({ content: "new", size: 3 });
    finish[0]({ content: "old", size: 3 });
  });
});
