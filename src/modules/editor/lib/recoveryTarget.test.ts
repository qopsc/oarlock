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
