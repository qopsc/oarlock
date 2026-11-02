import { expect, it } from "vitest";
import { settingsPatches } from "./settingsPatch";

it("emits only edited fields and individual tool choices", () => {
  expect(
    settingsPatches(
      { enabled: true, tools: { write: "allow", read: "deny" } },
      { enabled: false, tools: { read: "deny", type: "allow" } },
    ),
  ).toEqual([
    { path: ["enabled"], value: false },
    { path: ["tools", "write"], remove: true },
    { path: ["tools", "type"], value: "allow" },
  ]);
});
it("replaces transport variants but patches fields within the same variant", () => {
  const before = {
    transport: { type: "stdio", command: "server", args: [], cwd: null },
  };
  expect(
    settingsPatches(before, {
      transport: { ...before.transport, cwd: "/new" },
    }),
  ).toEqual([{ path: ["transport", "cwd"], value: "/new" }]);
  const next = { type: "http", url: "https://example.com", headers: [] };
  expect(settingsPatches(before, { transport: next })).toEqual([
    { path: ["transport"], value: next },
  ]);
});
