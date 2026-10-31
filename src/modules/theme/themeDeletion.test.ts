import { expect, it, vi } from "vitest";
import { deleteThemeSelection } from "./themeDeletion";
it("preserves a different selection made while deletion is pending", async () => {
  let finish: () => void = () => {};
  let selected = "theme-a";
  const remove = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const reset = vi.fn();
  const pending = deleteThemeSelection(
    "theme-a",
    remove,
    () => selected,
    reset,
  );
  selected = "theme-b";
  finish();
  await pending;
  expect(reset).not.toHaveBeenCalled();
});
it("preserves selection when persistence fails", async () => {
  const reset = vi.fn();
  await expect(
    deleteThemeSelection(
      "theme-a",
      async () => {
        throw Error("disk failure");
      },
      () => "theme-a",
      reset,
    ),
  ).rejects.toThrow("disk failure");
  expect(reset).not.toHaveBeenCalled();
});
it("resets only after successfully deleting the still-selected theme", async () => {
  const remove = vi.fn(async () => {}),
    reset = vi.fn();
  await deleteThemeSelection("theme-a", remove, () => "theme-a", reset);
  expect(reset).toHaveBeenCalledOnce();
  expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
    reset.mock.invocationCallOrder[0],
  );
});
