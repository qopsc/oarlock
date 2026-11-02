vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));
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
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(),
}));
import { gitWatchAdd } from "./gitWatch";
beforeEach(() => invoke.mockReset());
it("releases late repository acquisitions exactly once using their returned handle", async () => {
  let finish!: (handle: string) => void;
  invoke.mockImplementation((command) =>
    command === "git_watch_add"
      ? new Promise<string>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  const release = gitWatchAdd("/alias", { kind: "wsl", distro: "Ubuntu" });
  await vi.waitFor(() => expect(finish).toBeDefined());
  release();
  release();
  expect(invoke).toHaveBeenCalledTimes(1);
  finish("native-lease");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("watch_release", {
      handles: ["native-lease"],
    }),
  );
  release();
  expect(invoke).toHaveBeenCalledTimes(2);
});
