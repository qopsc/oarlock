const healthRetries = vi.hoisted(() => new Set<() => void>());
vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/modules/explorer/lib/watchHealth", () => ({
  watchHealth: {
    retry: vi.fn(async () => {
      for (const retry of healthRetries) retry();
    }),
    subscribe: (_changed: unknown, retry: () => void) => {
      healthRetries.add(retry);
      return {
        ready: Promise.resolve(),
        current: () => ({ revision: 0, error: null }),
        refresh: async () => {},
        dispose: () => healthRetries.delete(retry),
      };
    },
  },
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const { parentDir, createFileWatchClient } = await import("./watch");
const { authorizeFolder } = await import("@/modules/workspace/authorize");

const local = { kind: "local" } as const;

beforeEach(() => {
  invoke.mockReset();
  healthRetries.clear();
});

describe("watch handles", () => {
  it("retries a failed acquisition once and releases the recovered handle", async () => {
    const { watchHealth } = await import("./watchHealth");
    const { toast } = await import("sonner");
    invoke.mockRejectedValueOnce(new Error("directory unavailable"));
    const watch = createFileWatchClient(() => local);
    watch.add(["/retry"]);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    invoke.mockResolvedValue({
      directories: [{ path: "/retry", handle: "recovered" }],
      files: [],
    });
    await watchHealth.retry();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await watchHealth.retry();
    expect(invoke).toHaveBeenCalledTimes(2);
    watch.dispose();
    expect(invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["recovered"],
    });
    expect(healthRetries.size).toBe(0);
  });

  it("retries only surviving consumers after a failed batch", async () => {
    const { watchHealth } = await import("./watchHealth");
    const { toast } = await import("sonner");
    vi.mocked(toast.error).mockClear();
    invoke.mockImplementation(async (command, args) => {
      if (command !== "fs_watch_add") return;
      if (args.paths.includes("/gone")) throw new Error("gone");
      return { directories: [{ path: "/valid", handle: "valid" }], files: [] };
    });
    const watch = createFileWatchClient(() => local);
    watch.add(["/gone", "/valid"]);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    watch.remove(["/gone"]);
    await watchHealth.retry();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs_watch_add", {
        paths: ["/valid"],
        files: [],
        workspace: local,
      }),
    );
    watch.dispose();
    expect(invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["valid"],
    });
  });

  it("keeps a surviving duplicate's recovered handle", async () => {
    const { watchHealth } = await import("./watchHealth");
    const { toast } = await import("sonner");
    vi.mocked(toast.error).mockClear();
    invoke.mockRejectedValueOnce(new Error("unavailable"));
    const watch = createFileWatchClient(() => local);
    watch.add([], ["/repo/file", "/repo/file"]);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    watch.remove([], ["/repo/file"]);
    invoke.mockResolvedValue({
      directories: [],
      files: [{ path: "/repo/file", handle: "file" }],
    });
    await watchHealth.retry();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs_watch_add", {
        paths: [],
        files: ["/repo/file"],
        workspace: local,
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith("watch_release", {
      handles: ["file"],
    });
    watch.dispose();
    expect(invoke).toHaveBeenCalledWith("watch_release", { handles: ["file"] });
  });

  it("drops a removed failed batch and its notice while another watch stays active", async () => {
    const { watchHealth } = await import("./watchHealth");
    const { toast } = await import("sonner");
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.dismiss).mockClear();
    invoke.mockImplementation(async (command, args) => {
      if (command !== "fs_watch_add") return;
      if (args.paths.includes("/gone")) throw new Error("gone");
      return { directories: [{ path: "/valid", handle: "valid" }], files: [] };
    });
    const watch = createFileWatchClient(() => local);
    watch.add(["/valid"]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    watch.add(["/gone"]);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    watch.remove(["/gone"]);
    expect(toast.dismiss).toHaveBeenCalled();
    await watchHealth.retry();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(healthRetries.size).toBe(1);
    watch.dispose();
  });

  it("releases a late batch after disposal, with authorization and environment captured at acquisition", async () => {
    let authorized!: (path: string) => void;
    let env: typeof local | { kind: "wsl"; distro: string } = local;
    invoke.mockImplementation((command: string) =>
      command === "workspace_authorize"
        ? new Promise((resolve) => {
            authorized = resolve;
          })
        : Promise.resolve({
            directories: [{ path: "/repo/data", handle: "old" }],
            files: [],
          }),
    );
    void authorizeFolder("/repo/data", local);
    const watch = createFileWatchClient(() => env);
    watch.add(["/repo/data"]);
    watch.dispose();
    env = { kind: "wsl", distro: "Ubuntu" };
    authorized("/repo/data");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("watch_release", {
        handles: ["old"],
      }),
    );
    expect(invoke).toHaveBeenCalledWith("fs_watch_add", {
      paths: ["/repo/data"],
      files: [],
      workspace: local,
    });
    watch.dispose();
    expect(
      invoke.mock.calls.filter(([c]) => c === "watch_release"),
    ).toHaveLength(1);
  });

  it("releases a subset by handle and keeps overlapping consumers independent", async () => {
    let next = 0;
    invoke.mockImplementation(
      async (command: string, args: { paths: string[]; files: string[] }) => {
        if (command !== "fs_watch_add") return;
        return {
          directories: args.paths.map((path) => ({
            path,
            handle: `dir-${++next}`,
          })),
          files: args.files.map((path) => ({ path, handle: `file-${++next}` })),
        };
      },
    );
    const a = createFileWatchClient(() => local),
      b = createFileWatchClient(() => local);
    a.add(["/same", "/another"], ["/same/file"]);
    b.add(["/same"]);
    await vi.waitFor(() => expect(next).toBe(4));
    a.remove(["/same"]);
    a.remove(["/same"]);
    expect(invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["dir-1"],
    });
    a.dispose();
    expect(invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["dir-2", "file-3"],
    });
    b.dispose();
    expect(invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["dir-4"],
    });
    expect(
      invoke.mock.calls.filter(([c]) => c === "watch_release"),
    ).toHaveLength(3);
  });

  it("does not let an old reply become a newer registration of the same path", async () => {
    const replies: ((value: unknown) => void)[] = [];
    invoke.mockImplementation((command) =>
      command === "fs_watch_add"
        ? new Promise((resolve) => replies.push(resolve))
        : Promise.resolve(),
    );
    const watch = createFileWatchClient(() => local);
    watch.add(["/repo"]);
    watch.remove(["/repo"]);
    watch.add(["/repo"]);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]({ directories: [{ path: "/repo", handle: "new" }], files: [] });
    replies[0]({ directories: [{ path: "/repo", handle: "old" }], files: [] });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("watch_release", {
        handles: ["old"],
      }),
    );
    watch.dispose();
    expect(invoke).toHaveBeenCalledWith("watch_release", { handles: ["new"] });
  });
});

describe("parentDir", () => {
  it("returns the folder holding a path", () => {
    expect(parentDir("/home/u/a.ts")).toBe("/home/u");
    expect(parentDir("C:/Users/u/a.ts")).toBe("C:/Users/u");
    expect(parentDir("C:\\Users\\u\\a.ts")).toBe("C:\\Users\\u");
  });

  it("keeps the slash of a drive root, which `D:` alone would not mean", () => {
    expect(parentDir("D:/a.ts")).toBe("D:/");
    expect(parentDir("d:\\a.ts")).toBe("d:\\");
  });

  it("treats the filesystem root as its own parent", () => {
    expect(parentDir("/a.ts")).toBe("/");
    expect(parentDir("a.ts")).toBe("a.ts");
  });
});
