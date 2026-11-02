import { expect, it, vi } from "vitest";
import { authorizeContentHit } from "./authorizeContentHit";
const owner = {
  root: "/repo",
  spaceId: "ubuntu",
  env: { kind: "wsl" as const, distro: "Ubuntu" },
};
it("keeps authorization in the result environment and refuses opening after navigation", async () => {
  let finish = (_value: boolean) => {};
  let current = true;
  const authorize = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = authorizeContentHit(
    "/repo/a",
    owner,
    () => current,
    authorize,
  );
  expect(authorize).toHaveBeenCalledWith("/repo/a", owner.env);
  current = false;
  finish(true);
  expect(await pending).toBe(false);
});
it("does not authorize a stale hit and opens only after a current successful authorization", async () => {
  const authorize = vi.fn(async () => true);
  expect(
    await authorizeContentHit("/repo/a", owner, () => false, authorize),
  ).toBe(false);
  expect(authorize).not.toHaveBeenCalled();
  expect(
    await authorizeContentHit("/repo/a", owner, () => true, authorize),
  ).toBe(true);
  authorize.mockResolvedValue(false);
  expect(
    await authorizeContentHit("/repo/a", owner, () => true, authorize),
  ).toBe(false);
});
