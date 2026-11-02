import { expect, it } from "vitest";
import { actionableEntries, isUnreadableEntry } from "./unreadableEntries";

it("keeps unreadable names out of bulk selections", () => {
  const entries = [
    { path: "a.txt" },
    { path: "b�.txt", unreadable: true },
    { path: "c.txt", unreadable: false },
  ];
  expect(actionableEntries(entries).map((e) => e.path)).toEqual(["a.txt", "c.txt"]);
  expect(isUnreadableEntry(entries[1])).toBe(true);
  expect(isUnreadableEntry(entries[0])).toBe(false);
});
