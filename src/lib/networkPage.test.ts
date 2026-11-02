import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { networkPage } from "./networkPage";

let page: EventTarget & { __OARLOCK_NETWORK_PAGE__?: string };
beforeEach(() => {
  vi.useFakeTimers();
  page = new EventTarget();
  vi.stubGlobal("window", page);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses the native-delivered generation without IPC or idle listeners", async () => {
  page.__OARLOCK_NETWORK_PAGE__ = "native-page";
  const listen = vi.spyOn(page, "addEventListener");
  expect(await networkPage(new AbortController().signal)).toBe("native-page");
  expect(listen).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for native delivery and removes initialization listeners and timers", async () => {
  const remove = vi.spyOn(page, "removeEventListener");
  const pending = networkPage(new AbortController().signal);
  page.dispatchEvent(new Event("oarlock:network-page"));
  expect(vi.getTimerCount()).toBe(1);
  page.__OARLOCK_NETWORK_PAGE__ = "new-document";
  page.dispatchEvent(new Event("oarlock:network-page"));
  expect(await pending).toBe("new-document");
  expect(remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels waiting initialization without adopting a later generation", async () => {
  const owner = new AbortController();
  const reason = new Error("cancelled");
  const pending = networkPage(owner.signal);
  const rejection = expect(pending).rejects.toBe(reason);
  owner.abort(reason);
  await rejection;
  page.__OARLOCK_NETWORK_PAGE__ = "later";
  page.dispatchEvent(new Event("oarlock:network-page"));
  expect(vi.getTimerCount()).toBe(0);
  expect(() => networkPage(owner.signal)).toThrow(reason);
});

it("reports missing native initialization instead of waiting indefinitely", async () => {
  const pending = networkPage(new AbortController().signal);
  const rejection = expect(pending).rejects.toThrow("initialization timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});
