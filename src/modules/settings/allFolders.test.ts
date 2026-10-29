import { expect, it, vi } from "vitest";
const mutate = vi.hoisted(() => vi.fn());
vi.mock("./nativePreferences", () => ({ mutatePreferences: mutate }));
import { parsePreferences, setAiAllFolders, setAppAllFolders } from "./store";
it("folder access requires a stored boolean true", () => {
  for (const value of [undefined, false, "true", 1, null])
    expect(
      parsePreferences({ appAllFolders: value, aiAllFolders: value }),
    ).toMatchObject({ appAllFolders: false, aiAllFolders: false });
  expect(
    parsePreferences({ appAllFolders: true, aiAllFolders: true }),
  ).toMatchObject({ appAllFolders: true, aiAllFolders: true });
});
it("only native transactions change folder access", async () => {
  await setAppAllFolders(true);
  await setAiAllFolders(false);
  expect(mutate.mock.calls).toEqual([
    [{ kind: "set", key: "appAllFolders", value: true }],
    [{ kind: "set", key: "aiAllFolders", value: false }],
  ]);
});
