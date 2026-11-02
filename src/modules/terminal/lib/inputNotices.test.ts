import { expect, it, vi } from "vitest";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
const notice = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: notice }));
import {
  reportPendingInputCancellation,
  reportTerminalInputFailure,
  reportTerminalInputRefused,
} from "./inputNotices";

it("visibly reports a failed write and refuses later input", async () => {
  const writer = new BoundedPtyWriter((error) => reportTerminalInputFailure(3, error));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  writer.attach({
    id: 1, write: async () => { throw new Error("EIO"); },
    close: async () => {}, resize: async () => {},
  });
  writer.enqueue(Uint8Array.of(1));
  await vi.waitFor(() => expect(notice.error).toHaveBeenCalledWith("Terminal input stopped", expect.objectContaining({
    id: "terminal-input-3", duration: Number.POSITIVE_INFINITY,
  })));
  expect(writer.enqueue(Uint8Array.of(1))).toBe(false);
  consoleError.mockRestore(); writer.dispose();
});

it("reports refused input as a notice and leaves the terminal working", () => {
  notice.error.mockClear();
  const writer = new BoundedPtyWriter(() => {}, (reason) => reportTerminalInputRefused(3, reason));
  for (let n = 0; n < 257; n++) writer.reserveInput();
  expect(notice.message).toHaveBeenCalledWith("Terminal input not sent", expect.objectContaining({
    id: "terminal-input-refused-3",
  }));
  expect(notice.error).not.toHaveBeenCalled();
  expect(writer.hasFailed).toBe(false);
  writer.dispose();
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
