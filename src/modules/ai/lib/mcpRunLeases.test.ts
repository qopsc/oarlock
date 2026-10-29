import { expect, it, vi } from "vitest";
import {
  hasMcpRunLeases,
  holdMcpRun,
  releaseChatMcpRuns,
} from "./mcpRunLeases";

it("releases every lease for the stopped chat, without touching another chat", async () => {
  const first = vi.fn(async () => {}),
    second = vi.fn(async () => {}),
    other = vi.fn(async () => {});
  holdMcpRun("stopped", first);
  holdMcpRun("stopped", second);
  const keep = holdMcpRun("other", other);
  await releaseChatMcpRuns("stopped");
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  expect(hasMcpRunLeases("stopped")).toBe(false);
  expect(hasMcpRunLeases("other")).toBe(true);
  await keep.release();
});

it("shares concurrent cleanup and keeps failures reachable for Retry Stop", async () => {
  const release = vi
    .fn()
    .mockRejectedValueOnce(new Error("IPC failed"))
    .mockResolvedValue(undefined);
  const lease = holdMcpRun("retry-release", release);
  const first = lease.release();
  expect(lease.release()).toBe(first);
  await expect(first).rejects.toThrow("IPC failed");
  expect(hasMcpRunLeases("retry-release")).toBe(true);
  await releaseChatMcpRuns("retry-release");
  expect(hasMcpRunLeases("retry-release")).toBe(false);
  await lease.release();
  expect(release).toHaveBeenCalledTimes(2);
});
