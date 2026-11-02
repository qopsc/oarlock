import { expect, it } from "vitest";
import { createComposerImports } from "./composerImports";
import { cancelComposerWork } from "./composerWork";
it("Stop invalidates imports but cannot reach a later operation", () => {
  const owner = createComposerImports();
  const old = owner.begin("chat", { kind: "local" });
  cancelComposerWork("chat");
  expect(old.active()).toBe(false);
  const next = owner.begin("chat", { kind: "local" });
  old.finish();
  old.cancel();
  expect(next.active()).toBe(true);
  owner.cancel();
  expect(next.active()).toBe(false);
});
it("finished imports cannot commit again and close cancels every unfinished import", () => {
  const owner = createComposerImports();
  const finished = owner.begin("chat", { kind: "local" });
  finished.finish();
  const a = owner.begin("chat", { kind: "local" });
  const b = owner.begin("chat", { kind: "wsl", distro: "Ubuntu" });
  owner.cancel();
  expect(finished.active()).toBe(false);
  expect(finished.signal.aborted).toBe(false);
  expect(a.signal.aborted).toBe(true);
  expect(b.signal.aborted).toBe(true);
});

it("reports only first-start and last-finish transitions across concurrent imports", () => {
  const changes: boolean[] = [];
  const owner = createComposerImports((busy) => changes.push(busy));
  const first = owner.begin("chat", { kind: "local" });
  const last = owner.begin("chat", { kind: "local" });
  expect(owner.busy()).toBe(true);
  first.finish();
  expect(owner.busy()).toBe(true);
  expect(changes).toEqual([true]);
  last.cancel();
  expect(owner.busy()).toBe(false);
  expect(changes).toEqual([true, false]);
  const next = owner.begin("chat", { kind: "local" });
  last.finish();
  first.cancel();
  expect(owner.busy()).toBe(true);
  expect(changes).toEqual([true, false, true]);
  next.finish();
  expect(changes).toEqual([true, false, true, false]);
});
