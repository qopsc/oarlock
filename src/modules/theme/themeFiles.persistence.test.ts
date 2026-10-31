import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@/modules/theme/types";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));

vi.mock("@tauri-apps/api/core", () => core);

const paths = vi.hoisted(() => ({
  appConfigDir: vi.fn(async () => "/config"),
  join: vi.fn(async (...parts: string[]) =>
    parts.join("/").replace(/\/+/g, "/"),
  ),
}));

vi.mock("@tauri-apps/api/path", () => paths);

vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const events = vi.hoisted(() => {
  const listeners: ((payload: unknown) => void)[] = [];
  return {
    listeners,
    listen: vi.fn(
      async (_event: string, handler: (payload: unknown) => void) => {
        listeners.push(handler);
        return () => undefined;
      },
    ),
    emit: vi.fn(async () => undefined),
  };
});

vi.mock("@tauri-apps/api/event", () => events);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: events.listen }),
}));

import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  deleteThemeFile,
  handOffThemeEdit,
  onThemeEdit,
  writeThemeFile,
} from "./themeFiles";

const host = { kind: "local" };

function theme(id = "my-theme"): Theme {
  return {
    id,
    name: "Mine",
    author: "",
    description: "",
    variants: {},
  };
}

describe("theme file persistence", () => {
  beforeEach(() => {
    events.listeners.length = 0;
    core.invoke.mockReset();
    core.invoke.mockImplementation(async (cmd: string) =>
      cmd === "fs_save_document" ? { kind: "saved", version: "new" } : undefined,
    );
    paths.appConfigDir.mockClear();
    // A WSL window: theme files still live in the host's app config folder.
    useWorkspaceEnvStore.setState({ env: { kind: "wsl", distro: "Ubuntu" } });
  });

  it("writes pretty-printed JSON into the themes dir without recreating it", async () => {
    const path = await writeThemeFile(theme());

    expect(path).toEqual({ path: "/config/themes/my-theme.oarlock-theme", comparison: "same" });
    expect(core.invoke).toHaveBeenCalledWith("fs_stat", {
      path: "/config/themes",
      workspace: host,
    });
    const calls = core.invoke.mock.calls.filter(
      (c) => c[0] === "fs_create_dir",
    );
    expect(calls).toHaveLength(0);
    expect(core.invoke).toHaveBeenLastCalledWith("fs_save_document", {
      path: "/config/themes/my-theme.oarlock-theme",
      content: JSON.stringify(theme(), null, 2),
      expectedVersion: null,
      workspace: host,
      source: "theme",
    });
  });

  it("preserves an existing theme file and reports when it differs from the catalog", async () => {
    const existing = JSON.stringify({ ...theme(), name: "Other window's edit" });
    core.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_save_document") return { kind: "conflict", version: "existing" };
      if (cmd === "fs_read_file") return { kind: "text", content: existing };
      return undefined;
    });
    const result = await writeThemeFile(theme());
    expect(result).toEqual({ path: "/config/themes/my-theme.oarlock-theme", comparison: "different" });
    expect(core.invoke).toHaveBeenCalledWith("fs_save_document", {
      path: "/config/themes/my-theme.oarlock-theme",
      content: JSON.stringify(theme(), null, 2),
      expectedVersion: null,
      workspace: host,
      source: "theme",
    });
    expect(core.invoke).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("does not report a difference for equivalent JSON with reordered keys", async () => {
    core.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_save_document") return { kind: "conflict", version: "existing" };
      if (cmd === "fs_read_file") return { kind: "text", content: JSON.stringify({ variants: {}, description: "", author: "", name: "Mine", id: "my-theme" }) };
      return undefined;
    });
    await expect(writeThemeFile(theme())).resolves.toEqual({ path: "/config/themes/my-theme.oarlock-theme", comparison: "same" });
  });

  it("creates the themes dir first when it does not exist yet", async () => {
    core.invoke.mockImplementation((cmd: string) =>
      cmd === "fs_stat"
        ? Promise.reject(new Error("missing"))
        : Promise.resolve(cmd === "fs_save_document" ? { kind: "saved", version: "new" } : undefined),
    );

    await writeThemeFile(theme("t2"));

    expect(core.invoke).toHaveBeenCalledWith("fs_create_dir", {
      path: "/config/themes",
      workspace: host,
    });
  });

  it("preserves an existing file when it cannot be compared", async () => {
    core.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_save_document") return { kind: "conflict", version: "existing" };
      if (cmd === "fs_read_file") throw new Error("read failed");
      return undefined;
    });
    await expect(writeThemeFile(theme())).resolves.toEqual({ path: "/config/themes/my-theme.oarlock-theme", comparison: "unknown" });
  });

  it("deletes a theme file and swallows a missing-file failure", async () => {
    await deleteThemeFile("my-theme");
    expect(core.invoke).toHaveBeenCalledWith("fs_delete", {
      path: "/config/themes/my-theme.oarlock-theme",
      workspace: host,
    });

    core.invoke.mockRejectedValueOnce(new Error("enoent"));
    await expect(deleteThemeFile("gone")).resolves.toBeUndefined();
  });

  it("reports when safe deletion is unavailable", async () => {
    core.invoke.mockRejectedValueOnce(
      "This file operation is unavailable because its target cannot be safely verified.",
    );
    await expect(deleteThemeFile("my-theme")).rejects.toContain(
      "cannot be safely verified",
    );
  });

  it("hands theme creation to native window routing instead of broadcasting", async () => {
    const close = vi.fn(async () => {});
    await expect(handOffThemeEdit({ action: "create" }, close)).resolves.toBe(
      true,
    );
    expect(core.invoke).toHaveBeenCalledWith("app_theme_edit", {
      request: { action: "create" },
    });
    expect(events.emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("delivers theme-edit event payloads to the listener", async () => {
    const seen: unknown[] = [];
    const unlisten = await onThemeEdit((payload) => seen.push(payload));

    expect(events.listeners).toHaveLength(1);
    events.listeners[0]?.({ payload: { action: "create" } });
    events.listeners[0]?.({ payload: { action: "edit", id: "my-theme" } });
    expect(seen).toEqual([
      { action: "create" },
      { action: "edit", id: "my-theme" },
    ]);

    unlisten();
  });
});
