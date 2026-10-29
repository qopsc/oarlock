import { expect, it, vi } from "vitest";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
const notice = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: notice }));
import { reportPendingInputCancellation, reportTerminalInputFailure } from "./inputNotices";

it("visibly reports overflow and refuses later input", () => {
  const writer = new BoundedPtyWriter((error) => reportTerminalInputFailure(3, error));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  for (let n = 0; n < 257; n++) writer.reserveInput();
  expect(notice.error).toHaveBeenCalledWith("Terminal input stopped", expect.objectContaining({
    id: "terminal-input-3", duration: Number.POSITIVE_INFINITY,
  }));
  expect(writer.enqueue(Uint8Array.of(1))).toBe(false);
  consoleError.mockRestore(); writer.dispose();
});

it.each(["closed", "restarted"] as const)("visibly reports cancellation when %s", (reason) => {
  notice.message.mockClear();
  const writer = new BoundedPtyWriter(() => {});
  const finish = writer.reserveInput();
  if (!finish) throw new Error("Could not reserve input");
  reportPendingInputCancellation(writer, reason);
  writer.detach();
  const applied = vi.fn();
  finish(applied);
  expect(applied).not.toHaveBeenCalled();
  expect(notice.message).toHaveBeenCalledWith("Pending terminal input cancelled", expect.objectContaining({
    description: expect.stringContaining(reason),
  }));
  writer.dispose();
});
