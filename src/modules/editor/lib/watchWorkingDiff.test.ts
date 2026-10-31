vi.mock("@/modules/explorer/lib/watchHealth", () => ({
  watchHealth: {
    retry: vi.fn(async () => {}),
    subscribe: () => ({
      ready: Promise.resolve(),
      current: () => ({ revision: 0, error: null }),
      refresh: async () => {},
      dispose: vi.fn(),
    }),
  },
}));
import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  git: vi.fn(),
  fs: vi.fn(),
  gitOff: vi.fn(),
  fsOff: vi.fn(),
  authorize: vi.fn(async () => {}),
  gitChanged: (_roots: string[]) => {},
  fsChanged: (_paths: string[]) => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@/modules/workspace/authorize", () => ({
  authorizationSettled: fake.authorize,
}));
vi.mock("@/modules/source-control/gitWatch", () => ({
  listenGitChanged: fake.git,
}));
vi.mock("@/modules/explorer/lib/watch", () => ({
  listenFsChanged: fake.fs,
  parentDir: (p: string) => p.slice(0, p.lastIndexOf("/")),
}));
import { watchWorkingDiff } from "./watchWorkingDiff";
const env = { kind: "wsl", distro: "Ubuntu" } as const;
beforeEach(() => {
  vi.clearAllMocks();
  fake.invoke.mockReset().mockImplementation(async (command) =>
    command === "git_watch_add"
      ? "git-1"
      : {
          directories: [
            { path: "/repo", handle: "dir-1" },
            { path: "/repo/src", handle: "dir-2" },
          ],
          files: [{ path: "/repo/src/a.ts", handle: "file-1" }],
        },
  );
  fake.git.mockReset().mockImplementation(async (cb) => {
    fake.gitChanged = cb;
    return fake.gitOff;
  });
  fake.fs.mockReset().mockImplementation(async (cb) => {
    fake.fsChanged = cb;
    return fake.fsOff;
  });
});
it("filters events and releases every watch in its captured environment", async () => {
  const changed = vi.fn();
  const watch = watchWorkingDiff("/repo", "src/a.ts", env, changed);
  await watch.ready;
  fake.gitChanged(["/elsewhere"]);
  fake.fsChanged(["/repo/other.ts"]);
  expect(changed).not.toHaveBeenCalled();
  fake.gitChanged(["/repo"]);
  fake.fsChanged(["/repo/src/a.ts"]);
  fake.fsChanged(["/repo/src"]);
  expect(changed).toHaveBeenCalledTimes(3);
  watch.dispose();
  watch.dispose();
  await vi.waitFor(() =>
    expect(fake.invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["git-1"],
    }),
  );
  expect(fake.invoke).toHaveBeenCalledWith("watch_release", {
    handles: ["dir-1", "dir-2", "file-1"],
  });
  expect(fake.gitOff).toHaveBeenCalledOnce();
  expect(fake.fsOff).toHaveBeenCalledOnce();
  fake.gitChanged(["/repo"]);
  expect(changed).toHaveBeenCalledTimes(3);
});
it("waits for pending additions before removing and never starts later acquisitions after disposal", async () => {
  let finish!: () => void;
  fake.invoke.mockImplementation((command) =>
    command === "git_watch_add"
      ? new Promise<string>((resolve) => {
          finish = () => resolve("git-1");
        })
      : Promise.resolve(),
  );
  const watch = watchWorkingDiff("/repo", "file.txt", env, vi.fn());
  await vi.waitFor(() => expect(finish).toBeDefined());
  watch.dispose();
  expect(fake.invoke.mock.calls.map(([c]) => c)).not.toContain("watch_release");
  finish();
  await watch.ready;
  await vi.waitFor(() =>
    expect(fake.invoke.mock.calls.map(([c]) => c)).toEqual([
      "git_watch_add",
      "watch_release",
    ]),
  );
});
it("allows cleanup after partial registration fails", async () => {
  fake.invoke.mockImplementation(async (command) => {
    if (command === "fs_watch_add") throw new Error("watch denied");
    return "git-1";
  });
  const watch = watchWorkingDiff("/repo", "file.txt", env, vi.fn());
  await expect(watch.ready).rejects.toThrow("watch denied");
  watch.dispose();
  await vi.waitFor(() =>
    expect(fake.invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["git-1"],
    }),
  );
  expect(fake.gitOff).toHaveBeenCalledOnce();
  expect(fake.fsOff).toHaveBeenCalledOnce();
});
