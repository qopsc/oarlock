import { expect, it } from "vitest";
import { createDirectoryReadOrder } from "./directoryReadOrder";

it("keeps the newest result for a folder while other folders remain independent", async () => {
  const order = createDirectoryReadOrder();
  const pending: ((value: string) => void)[] = [];
  const shown: string[] = [];
  const read = async (path: string) => {
    const current = order.begin(path);
    const value = await new Promise<string>((done) => { pending.push(done); });
    if (current()) shown.push(value);
  };
  const old = read("/repo/a");
  const newer = read("/repo/a");
  const other = read("/repo/b");
  pending[1]("new"); pending[2]("other"); pending[0]("old");
  await Promise.all([old, newer, other]);
  expect(shown).toEqual(["new", "other"]);
});

it("invalidates listings after the directory or workspace is removed", () => {
  const order = createDirectoryReadOrder();
  const removed = order.begin("/repo/a");
  order.forget(["/repo/a"]);
  expect(removed()).toBe(false);
  const oldWorkspace = order.begin("/repo/b");
  order.reset();
  expect(oldWorkspace()).toBe(false);
});
