import { expect, it, vi } from "vitest";
import { cwdListingKey, loadCwdListing } from "./cwdListing";

it("distinguishes the same path in different environments", () => {
  expect(cwdListingKey("/repo", false, { kind: "wsl", distro: "Ubuntu" }))
    .not.toBe(cwdListingKey("/repo", false, { kind: "wsl", distro: "Debian" }));
});
it("does not publish an old directory response after navigation", async () => {
  let first!: (items: string[]) => void;
  let second!: (items: string[]) => void;
  let owner = 1;
  const publish = vi.fn();
  const old = loadCwdListing("old", () => new Promise((resolve) => { first = resolve; }), () => owner === 1, publish);
  owner = 2;
  const next = loadCwdListing("next", () => new Promise((resolve) => { second = resolve; }), () => owner === 2, publish);
  second(["new"]); first(["old"]);
  await Promise.all([old, next]);
  expect(publish).toHaveBeenCalledExactlyOnceWith({ key: "next", children: ["new"], error: null });
});
