import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  hostname: vi.fn(async () => "Users-MacBook-Pro.local"),
  revealItemInDir: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));
vi.mock("@tauri-apps/plugin-os", () => ({ hostname: native.hostname }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: native.openUrl,
  revealItemInDir: native.revealItemInDir,
}));

import {
  openTerminalLink as openLink,
  setTerminalLinkNavigation,
  openTerminalPreview,
  setTerminalFileOpener,
  setTerminalPreviewOpener,
} from "./terminalLinkOpen";

let owner: AbortController;
beforeEach(() => {
  owner = new AbortController();
  setTerminalLinkNavigation("space-a", 1);
});
const openTerminalLink = (
  uri: string,
  cwd: string | null,
  settled: () => void,
) =>
  openLink(uri, cwd, settled, {
    workspace: { kind: "local" },
    active: () => !owner.signal.aborted,
  });

describe("opening terminal links", () => {
  afterEach(() => {
    vi.clearAllMocks();
    setTerminalFileOpener(null);
  });

  it("opens a file hyperlink from this machine in the editor", async () => {
    const opened = vi.fn();
    setTerminalFileOpener(opened);
    native.invoke.mockResolvedValue({ kind: "file" });

    await openTerminalLink(
      "file://users-macbook-pro.local/etc/hosts",
      null,
      () => {},
    );

    // The click authorizes the file's folder, before anything reads it.
    expect(native.invoke.mock.calls).toEqual([
      [
        "workspace_authorize",
        { path: "/etc/hosts", workspace: { kind: "local" }, opened: "file" },
      ],
      ["fs_stat", { path: "/etc/hosts", workspace: { kind: "local" } }],
    ]);
    expect(opened).toHaveBeenCalledWith("/etc/hosts", null, null, "space-a");
    expect(native.revealItemInDir).not.toHaveBeenCalled();
  });

  it("shows a folder hyperlink in the file manager", async () => {
    const opened = vi.fn();
    setTerminalFileOpener(opened);
    native.invoke.mockResolvedValue({ kind: "dir" });

    await openTerminalLink(
      "file://users-macbook-pro.local/etc",
      null,
      () => {},
    );

    expect(native.revealItemInDir).toHaveBeenCalledWith("/etc");
    expect(opened).not.toHaveBeenCalled();
  });

  it("opens a web link in the preview when the app takes it, else in the browser", async () => {
    setTerminalPreviewOpener((url) => url.startsWith("http://localhost"));
    const settled = vi.fn();

    await openTerminalLink("http://localhost:3000/", null, settled);
    expect(native.openUrl).not.toHaveBeenCalled();

    await openTerminalLink("https://oarlock.app/", null, settled);
    expect(native.openUrl).toHaveBeenCalledWith("https://oarlock.app/");
    expect(settled).toHaveBeenCalledOnce();
    setTerminalPreviewOpener(null);
  });

  it("leaves another machine's files alone", async () => {
    await openTerminalLink("file://build-server/etc/hosts", null, () => {});

    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe("terminal link preview routing", () => {
  it("sends links to the browser unless the app takes them", () => {
    expect(openTerminalPreview("http://localhost:5173")).toBe(false);
    const seen: string[] = [];
    setTerminalPreviewOpener((url) => {
      seen.push(url);
      return url.includes("localhost");
    });
    expect(openTerminalPreview("http://localhost:5173")).toBe(true);
    expect(openTerminalPreview("https://oarlock.app")).toBe(false);
    setTerminalPreviewOpener(null);
    expect(openTerminalPreview("http://localhost:5173")).toBe(false);
    expect(seen).toEqual(["http://localhost:5173", "https://oarlock.app"]);
  });
});

it("does not reinterpret a pending file click in a different environment", async () => {
  const { useWorkspaceEnvStore } = await import("@/modules/workspace/env");
  useWorkspaceEnvStore.setState({ env: { kind: "local" } });
  native.invoke.mockClear();
  native.invoke.mockResolvedValue({ kind: "file" });
  setTerminalFileOpener(vi.fn());
  const opening = openTerminalLink("/repo/a.ts", "/repo", () => {});
  useWorkspaceEnvStore.setState({ env: { kind: "wsl", distro: "Debian" } });
  await opening;
  const calls = native.invoke.mock.calls;
  useWorkspaceEnvStore.setState({ env: { kind: "local" } });
  setTerminalFileOpener(null);
  expect(calls.find(([name]) => name === "fs_stat")?.[1]).toMatchObject({
    workspace: { kind: "local" },
  });
});

it.each(["navigation", "restart", "close"])(
  "cancels a delayed file click on %s",
  async (reason) => {
    native.invoke.mockClear();
    let finish!: (value: { kind: string }) => void;
    native.invoke.mockImplementation(async (name) =>
      name === "fs_stat"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    const opened = vi.fn();
    setTerminalFileOpener(opened);
    const pending = openTerminalLink("a.ts:42", "/repo", () => {});
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (reason === "navigation") {
      setTerminalLinkNavigation("space-b", 2);
      setTerminalLinkNavigation("space-a", 1);
    } else owner.abort();
    finish({ kind: "file" });
    await pending;
    expect(opened).not.toHaveBeenCalled();
  },
);

it("cancels before authorization when navigation wins the lazy import", async () => {
  native.invoke.mockClear();
  const pending = openTerminalLink("a.ts", "/repo", () => {});
  setTerminalLinkNavigation("space-b", 2);
  await pending;
  expect(native.invoke).not.toHaveBeenCalled();
});

it("uses the owning WSL home and captured space for tilde links", async () => {
  native.invoke.mockClear();
  native.invoke.mockImplementation(async (name) =>
    name === "wsl_home" ? "/home/ubuntu" : { kind: "file" },
  );
  const opened = vi.fn();
  setTerminalFileOpener(opened);
  await openLink("~/a.ts:12", "/repo", () => {}, {
    workspace: { kind: "wsl", distro: "Ubuntu" },
    active: () => !owner.signal.aborted,
  });
  expect(native.invoke).toHaveBeenCalledWith("fs_stat", {
    path: "/home/ubuntu/a.ts",
    workspace: { kind: "wsl", distro: "Ubuntu" },
  });
  expect(opened).toHaveBeenCalledWith("/home/ubuntu/a.ts", 12, null, "space-a");
});

it("does not restore terminal focus after an external open finishes in another tab", async () => {
  setTerminalPreviewOpener(null);
  let finish!: () => void;
  native.openUrl.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const focus = vi.fn();
  await openTerminalLink("https://example.com", null, focus);
  setTerminalLinkNavigation("space-a", 2);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(focus).not.toHaveBeenCalled();
});

it("keeps scrollback links usable after input ends, until the terminal generation closes", async () => {
  const { TerminalRequestLifetime } = await import("./TerminalRequestLifetime");
  const requests = new TerminalRequestLifetime();
  requests.dispose(); // Shell exit ends clipboard/input work, but retains the model.
  native.invoke.mockImplementation(async () => ({ kind: "file" }));
  const opened = vi.fn();
  setTerminalFileOpener(opened);
  const generation = {
    workspace: { kind: "local" as const },
    active: () => !owner.signal.aborted,
  };
  await openLink("/repo/after-exit.rs", "/repo", () => {}, generation);
  expect(opened).toHaveBeenCalledOnce();
  owner.abort(); // Closing or restarting ends the retained model's generation.
  await openLink("/repo/after-exit.rs", "/repo", () => {}, generation);
  expect(opened).toHaveBeenCalledOnce();
});
