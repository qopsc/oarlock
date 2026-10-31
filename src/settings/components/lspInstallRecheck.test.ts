import { expect, it, vi } from "vitest";
import { recheckLspInstall } from "./lspInstallRecheck";

it("does not enable a server after its dialog closes or changes", async () => {
  let current = true;
  let finish!: (path: string | null) => void;
  const save = vi.fn();
  const begin = vi.fn();
  const result = recheckLspInstall(() => current,
    () => new Promise((resolve) => { finish = resolve; }), begin, save);
  current = false;
  finish("/bin/server");
  expect(await result).toBe("cancelled");
  expect(begin).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("reports missing binaries and lets a failed save be retried", async () => {
  const begin = vi.fn();
  const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
  expect(await recheckLspInstall(() => true, async () => null, begin, save)).toBe("missing");
  expect(begin).not.toHaveBeenCalled();
  await expect(recheckLspInstall(() => true, async () => "/bin/server", begin, save)).rejects.toThrow("disk full");
  expect(await recheckLspInstall(() => true, async () => "/bin/server", begin, save)).toBe("saved");
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not close a replacement dialog after a save completes", async () => {
  let current = true;
  let finish!: () => void;
  const pending = recheckLspInstall(() => current, async () => "/bin/server", vi.fn(),
    () => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  current = false;
  finish();
  expect(await pending).toBe("cancelled");
});
