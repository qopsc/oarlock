import { expect, it } from "vitest";
import { canMoveBetweenSpaces } from "./environmentMove";
const spaces = [
  { id: "local", env: { kind: "local" } as const },
  { id: "legacy" },
  { id: "ubuntu1", env: { kind: "wsl", distro: "Ubuntu" } as const },
  { id: "ubuntu2", env: { kind: "wsl", distro: "Ubuntu" } as const },
  { id: "debian", env: { kind: "wsl", distro: "Debian" } as const },
];
it("allows same-environment movement and local legacy spaces", () => {
  expect(canMoveBetweenSpaces(spaces, "ubuntu1", "ubuntu2")).toBe(true);
  expect(canMoveBetweenSpaces(spaces, "local", "legacy")).toBe(true);
  expect(canMoveBetweenSpaces(spaces, "ubuntu1", "ubuntu1")).toBe(true);
});
it.each([
  ["local", "ubuntu1"],
  ["ubuntu1", "debian"],
  ["debian", "local"],
  ["missing", "local"],
])("refuses a resource move from %s to %s", (from, to) => {
  expect(canMoveBetweenSpaces(spaces, from, to)).toBe(false);
});
