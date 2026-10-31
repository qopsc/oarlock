import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

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
});
