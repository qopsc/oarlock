import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { signingPolicy } from "../git-worker/build.mjs";

describe("Git helper signing policy", () => {
  it("allows unsigned local release builds with a refusing ad-hoc helper", () => {
    expect(signingPolicy({ TAURI_ENV_DEBUG: "false" }).identity).toBe("-");
  });
  it.each([{}, { APPLE_SIGNING_IDENTITY: "-" }, { TAURI_ENV_DEBUG: "true" }])(
    "refuses unsigned distribution regardless of build profile: %j",
    (env) => {
      expect(() =>
        signingPolicy({ ...env, OARLOCK_DISTRIBUTION_BUILD: "1" }),
      ).toThrow("Distribution");
    },
  );
  it("requires a team for signed builds", () => {
    expect(() =>
      signingPolicy({ APPLE_SIGNING_IDENTITY: "Developer ID" }),
    ).toThrow("APPLE_TEAM_ID");
    expect(
      signingPolicy({
        OARLOCK_DISTRIBUTION_BUILD: "1",
        APPLE_SIGNING_IDENTITY: "Developer ID",
        APPLE_TEAM_ID: "ABCDEFGHIJ",
      }),
    ).toEqual({ identity: "Developer ID", teamId: "ABCDEFGHIJ" });
  });
  it("requires distribution signing in the release workflow", () => {
    expect(
      readFileSync(
        new URL("../../.github/workflows/release.yml", import.meta.url),
        "utf8",
      ),
    ).toContain('OARLOCK_DISTRIBUTION_BUILD: "1"');
  });
});
