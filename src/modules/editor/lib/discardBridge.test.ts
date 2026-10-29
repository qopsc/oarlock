import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  off: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: fake.listen }),
}));
vi.mock("sonner", () => ({
  toast: { error: fake.error, dismiss: fake.dismiss },
}));
vi.mock("./gitSignals", () => ({ prepareNativeDiscard: fake.prepare }));
import {
  discardAcrossWindows,
  installDiscardCoordinator,
} from "./discardBridge";
let stop: (() => void) | undefined;
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.resetAllMocks();
  fake.listen.mockResolvedValue(fake.off);
  fake.invoke.mockResolvedValue({ token: "page", events: [] });
  fake.prepare.mockReturnValue({ complete: vi.fn(), dispose: vi.fn() });
});
afterEach(() => {
  stop?.();
  stop = undefined;
});
it("installs its listener before registering and recovers missed events from the snapshot", async () => {
  fake.invoke.mockImplementation(async (command: string) => {
    if (command === "git_discard_register") {
      expect(fake.listen).toHaveBeenCalledOnce();
      return {
        token: "page",
        events: [
          {
            id: "1",
            token: "page",
            nonce: "n",
            owner: false,
            phase: "prepare",
            paths: ["/repo/file"],
            workspace: { kind: "local" },
          },
        ],
      };
    }
  });
  stop = installDiscardCoordinator();
  await flush();
  expect(fake.prepare).toHaveBeenCalledWith(
    { kind: "local" },
    true,
    expect.any(Function),
  );
  expect(fake.invoke).toHaveBeenCalledWith("git_discard_prepared", {
    token: "page",
    id: "1",
    ok: true,
  });
});
it("unregisters a late registration response after unmount", async () => {
  let finish!: (value: unknown) => void;
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "git_discard_register"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  stop = installDiscardCoordinator();
  await flush();
  stop();
  finish({ token: "late", events: [] });
  await flush();
  expect(fake.invoke).toHaveBeenCalledWith("git_discard_unregister", {
    token: "late",
  });
  await expect(
    discardAcrossWindows("/repo", [], { kind: "local" }),
  ).rejects.toThrow("not ready");
});
it("failed registration exposes Retry and never dispatches Git", async () => {
  fake.invoke.mockRejectedValueOnce(new Error("unavailable"));
  stop = installDiscardCoordinator();
  await flush();
  await expect(
    discardAcrossWindows("/repo", [], { kind: "local" }),
  ).rejects.toThrow("not ready");
  const action = fake.error.mock.calls[0][1].action;
  expect(action.label).toBe("Retry");
  action.onClick();
  await flush();
  expect(
    fake.invoke.mock.calls.filter(([cmd]) => cmd === "git_discard_register"),
  ).toHaveLength(2);
  expect(fake.dismiss).toHaveBeenCalledWith("discard-sync");
});
