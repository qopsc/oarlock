import { afterEach, expect, it } from "vitest";
import {
  observeRecoveryTarget,
  recoveryMutationCoverage,
  recoveryTargetsChanged,
} from "./recoveryTarget";

afterEach(() => recoveryMutationCoverage(false));
it("requires coverage and invalidates pending work when coverage is lost", () => {
  expect(() => observeRecoveryTarget("/a", "local")).toThrow("unavailable");
  recoveryMutationCoverage(true);
  const target = observeRecoveryTarget("/a", "local");
  recoveryMutationCoverage(false);
  recoveryMutationCoverage(true);
  expect(target.changed()).toBe(true);
  target.dispose();
});
it("scopes destination and ancestor changes, ignoring other environments and path prefixes", () => {
  recoveryMutationCoverage(true);
  const target = observeRecoveryTarget("/work/a", "ubuntu");
  recoveryTargetsChanged("debian", ["/work"]);
  recoveryTargetsChanged("ubuntu", ["/worker", "/work/another"]);
  expect(target.changed()).toBe(false);
  recoveryTargetsChanged("ubuntu", ["/work"]);
  expect(target.changed()).toBe(true);
  target.dispose();
});
it("disposal removes tracking even if a write has not replied", () => {
  recoveryMutationCoverage(true);
  const target = observeRecoveryTarget("/a", "local");
  target.dispose();
  recoveryTargetsChanged("local", ["/a"]);
  recoveryMutationCoverage(false);
  expect(target.changed()).toBe(false);
});

it("native mutation history invalidates aliases that local path matching cannot identify", async () => {
  const { observeNativeRecoveryTarget } = await import("./recoveryTarget");
  recoveryMutationCoverage(true);
  let nativeChanged = false;
  const ended: string[] = [];
  const target = await observeNativeRecoveryTarget("/alias/draft", "local", {
    begin: async () => "owned-handle",
    changed: async (id) => {
      expect(id).toBe("owned-handle");
      return nativeChanged;
    },
    end: async (id) => {
      ended.push(id);
    },
  });
  recoveryTargetsChanged("local", ["/real/draft", "/real/moved"]);
  nativeChanged = true;
  expect(await target.changed()).toBe(true);
  target.dispose();
  target.dispose();
  expect(ended).toEqual(["owned-handle"]);
});
it("native acquisition failure drops its local recovery observer", async () => {
  const { observeNativeRecoveryTarget } = await import("./recoveryTarget");
  recoveryMutationCoverage(true);
  await expect(
    observeNativeRecoveryTarget("/a", "local", {
      begin: async () => {
        throw new Error("unavailable");
      },
      changed: async () => false,
      end: async () => {},
    }),
  ).rejects.toThrow("unavailable");
  recoveryMutationCoverage(false);
  recoveryMutationCoverage(true);
  const next = observeRecoveryTarget("/a", "local");
  expect(next.changed()).toBe(false);
  next.dispose();
});
