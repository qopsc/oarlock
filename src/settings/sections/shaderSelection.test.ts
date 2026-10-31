import { expect, it, vi } from "vitest";
import { ShaderSelection } from "./shaderSelection";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const file = (name: string, text: () => Promise<string>) => ({ name, text, size: 12 });
const setup = () => {
  const snapshot = vi.fn().mockResolvedValue({ revision: 1, values: { terminalCustomShader: null } });
  const save = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const owner = new ShaderSelection({ snapshot, save, remove, error, maxBytes: 262144, validate: async () => null });
  return { owner, snapshot, save, remove, error };
};

it("does not restore an old shader after a newer choice or reset", async () => {
  const { owner, save, remove } = setup();
  const old = deferred<string>();
  const pending = owner.choose(file("old", () => old.promise));
  await flush();
  await owner.choose(file("new", async () => "new source"));
  old.resolve("old source");
  await pending;
  expect(save).toHaveBeenCalledExactlyOnceWith({ name: "new", source: "new source" }, 1);
  const delayed = deferred<string>();
  const stale = owner.choose(file("stale", () => delayed.promise));
  await flush();
  await owner.reset();
  delayed.resolve("stale source");
  await stale;
  expect(remove).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
});

it("orders reset after a shader write already in flight", async () => {
  const { owner, save, remove } = setup();
  const writing = deferred<void>();
  save.mockReturnValueOnce(writing.promise);
  const choice = owner.choose(file("old", async () => "source"));
  await flush();
  const reset = owner.reset();
  await flush();
  expect(remove).not.toHaveBeenCalled();
  writing.resolve();
  await Promise.all([choice, reset]);
  expect(remove).toHaveBeenCalledOnce();
});

it("a reopened Settings view waits for the earlier view's in-flight write", async () => {
  const first = setup();
  const second = setup();
  const writing = deferred<void>();
  first.save.mockReturnValueOnce(writing.promise);
  const old = first.owner.choose(file("old", async () => "old"));
  await flush();
  first.owner.dispose();
  const newer = second.owner.choose(file("new", async () => "new"));
  await flush();
  expect(second.snapshot).not.toHaveBeenCalled();
  writing.resolve();
  await Promise.all([old, newer]);
  expect(second.save).toHaveBeenCalledExactlyOnceWith({ name: "new", source: "new" }, 1);
});

it("finishes an explicit removal even if Settings closes while it waits", async () => {
  const { owner, save, remove } = setup();
  const writing = deferred<void>();
  save.mockReturnValueOnce(writing.promise);
  const choice = owner.choose(file("old", async () => "source"));
  await flush();
  const reset = owner.reset();
  owner.dispose();
  writing.resolve();
  await Promise.all([choice, reset]);
  expect(remove).toHaveBeenCalledOnce();
});

it("does not overwrite a newer shader saved by another window", async () => {
  const { owner, save, snapshot } = setup();
  save.mockRejectedValueOnce("PREFERENCES_REVISION_CHANGED");
  snapshot.mockResolvedValueOnce({ revision: 1, values: { terminalCustomShader: null } })
    .mockResolvedValueOnce({ revision: 2, values: { terminalCustomShader: { name: "new", source: "new" } } });
  await owner.choose(file("old", async () => "old"));
  expect(save).toHaveBeenCalledOnce();
});

it("retries unrelated preference changes and cancels after disposal", async () => {
  const { owner, save, snapshot } = setup();
  save.mockRejectedValueOnce("PREFERENCES_REVISION_CHANGED").mockResolvedValueOnce(undefined);
  snapshot.mockResolvedValueOnce({ revision: 1, values: { terminalCustomShader: null } })
    .mockResolvedValueOnce({ revision: 2, values: { terminalCustomShader: null } });
  await owner.choose(file("mine", async () => "source"));
  expect(save).toHaveBeenLastCalledWith({ name: "mine", source: "source" }, 2);
  const pendingRead = deferred<string>();
  const pending = owner.choose(file("later", () => pendingRead.promise));
  await flush();
  owner.dispose();
  pendingRead.resolve("late");
  await pending;
  expect(save).toHaveBeenCalledTimes(2);
});
