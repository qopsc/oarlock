import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ invoke: vi.fn(), search: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@/modules/command-palette/hooks/requestContentSearch", () => ({ requestContentSearch: fake.search }));
import { profileGrepCancellation, withProfileWatch } from "./fsLifecycle";

beforeEach(() => { fake.invoke.mockReset(); fake.search.mockReset(); });

it("releases the exact acquired watch handles when work fails", async () => {
  fake.invoke.mockResolvedValueOnce({ directories: [{ handle: "dir-1" }], files: [{ handle: "file-1" }] });
  fake.invoke.mockResolvedValueOnce(undefined);
  await expect(withProfileWatch(["/dir"], ["/dir/file"], async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(fake.invoke).toHaveBeenNthCalledWith(1, "fs_watch_add", { paths: ["/dir"], files: ["/dir/file"], workspace: { kind: "local" } });
  expect(fake.invoke).toHaveBeenNthCalledWith(2, "watch_release", { handles: ["dir-1", "file-1"] });
});

it("cancels the first owned grep before starting the replacement", async () => {
  fake.search.mockImplementationOnce((_args: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  fake.search.mockResolvedValueOnce({ hits: [], truncated: false, cancelled: false });
  expect(await profileGrepCancellation("/repo", async () => {})).toBe(true);
  expect(fake.search).toHaveBeenCalledTimes(2);
  expect(fake.search.mock.calls[0][1].aborted).toBe(true);
  expect(fake.search.mock.calls[1][0]).toMatchObject({ root: "/repo", workspace: { kind: "local" }, channel: "sidebar" });
});
