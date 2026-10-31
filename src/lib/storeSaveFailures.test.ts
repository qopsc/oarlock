import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), error: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
import { installStoreSaveFailureReporting } from "./storeSaveFailures";

it("shows a persistent notice when a background store save fails", async () => {
  mocks.listen.mockResolvedValue(() => {});
  await installStoreSaveFailureReporting();
  expect(mocks.listen).toHaveBeenCalledWith("oarlock://store-save-failed", expect.any(Function));
  const callback = mocks.listen.mock.calls[0]?.[1];
  callback({ payload: "spaces.json: permission denied" });
  expect(mocks.error).toHaveBeenCalledWith("Could not save application data", {
    description: "spaces.json: permission denied", duration: Number.POSITIVE_INFINITY,
  });
});

it("shows when the error listener cannot be installed", async () => {
  mocks.error.mockClear();
  mocks.listen.mockRejectedValueOnce(new Error("listener unavailable"));
  await installStoreSaveFailureReporting();
  expect(mocks.error).toHaveBeenCalledWith("Could not monitor application data saves", {
    description: "Error: listener unavailable", duration: Number.POSITIVE_INFINITY,
  });
});
