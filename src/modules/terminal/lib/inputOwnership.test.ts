import { expect, it } from "vitest";
import { captureInputOwner } from "./inputOwnership";

it.each(["navigation", "restart", "input", "cwd", "focus", "exit", "replacement"])(
  "invalidates a captured terminal owner after %s changes", (kind) => {
    const session = { workspace: { kind: "local" as const }, generation: 1,
      inputRevision: 0, cwdRevision: 0, focusRevision: 0, pty: { id: 1 },
      lastCwd: "/repo", initialCwd: "/repo",
      disposed: false, shellExited: false };
    let current: typeof session | undefined = session;
    let navigation = true;
    const owner = captureInputOwner(session, () => current, () => navigation);
    if (!owner) throw new Error("Could not capture owner");
    expect(owner.active()).toBe(true);
    if (kind === "navigation") navigation = false;
    if (kind === "restart") session.generation++;
    if (kind === "input") session.inputRevision++;
    if (kind === "cwd") session.cwdRevision++;
    if (kind === "focus") session.focusRevision++;
    if (kind === "exit") session.shellExited = true;
    if (kind === "replacement") current = { ...session };
    expect(owner.active()).toBe(false);
  },
);

it("does not treat the first report of the expected startup directory as navigation", () => {
  const session = { workspace: { kind: "local" as const }, generation: 1,
    inputRevision: 0, cwdRevision: 0, focusRevision: 0, pty: { id: 1 },
    lastCwd: null as string | null, initialCwd: "/repo", disposed: false, shellExited: false };
  const owner = captureInputOwner(session, () => session, () => true);
  if (!owner) throw new Error("Could not capture owner");
  session.lastCwd = "/repo";
  session.cwdRevision++;
  expect(owner.active()).toBe(true);
  session.lastCwd = "/different";
  session.cwdRevision++;
  expect(owner.active()).toBe(false);
});
