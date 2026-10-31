import { expect, it, vi } from "vitest";
import { captureCompletionOwner } from "./completionOwnership";

function setup() {
  const session = { workspace: { kind: "wsl" as const, distro: "Ubuntu" }, lastCwd: "/repo", cwdRevision: 0, pty: { id: 42 }, generation: 7, disposed: false, shellExited: false };
  let current: typeof session | undefined = session;
  let navigation = true;
  let prompt = true;
  const verify = vi.fn().mockResolvedValue("posix" as const);
  const owner = captureCompletionOwner(session, () => current, () => navigation, () => prompt, verify);
  if (!owner) throw Error("Expected owner");
  return { session, owner, verify, replace: () => { current = { ...session }; }, navigate: () => { navigation = false; }, leavePrompt: () => { prompt = false; } };
}
it("verifies the exact terminal id, cwd and owning environment", async () => {
  const t = setup();
  await expect(t.owner.verify()).resolves.toBe("posix");
  expect(t.verify).toHaveBeenCalledWith(42, "/repo", { kind: "wsl", distro: "Ubuntu" });
});
it.each(["leaf switch", "navigation", "restart", "pty replacement", "cwd change", "close", "shell exit", "prompt loss"])("invalidates the captured owner on %s", async (change) => {
  const t = setup();
  if (change === "leaf switch") t.replace();
  if (change === "navigation") t.navigate();
  if (change === "restart") t.session.generation++;
  if (change === "pty replacement") t.session.pty = { id: 42 };
  if (change === "cwd change") t.session.lastCwd = "/other";
  if (change === "close") t.session.disposed = true;
  if (change === "shell exit") t.session.shellExited = true;
  if (change === "prompt loss") t.leavePrompt();
  expect(t.owner.active()).toBe(false);
  await expect(t.owner.verify()).rejects.toThrow("Terminal changed");
  expect(t.verify).not.toHaveBeenCalled();
});
it("rejects a shell verification that finishes after restart", async () => {
  const t = setup();
  let finish: (value: "posix") => void = () => {};
  t.verify.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const result = t.owner.verify();
  t.session.generation++;
  finish("posix");
  await expect(result).rejects.toThrow("Terminal changed");
});

it("invalidates a request even when the cwd returns to the same path", () => {
  const t = setup();
  t.session.lastCwd = "/other";
  t.session.cwdRevision++;
  t.session.lastCwd = "/repo";
  t.session.cwdRevision++;
  expect(t.owner.active()).toBe(false);
});
