import { afterEach, describe, expect, it, vi } from "vitest";
import { mruRank, mruSnapshot, recordUse } from "./mru";

describe("mruRank", () => {
  it("returns the recorded timestamp for a known id", () => {
    expect(mruRank({ a: 5, b: 9 }, "b")).toBe(9);
  });

  it("returns 0 for an id not in the snapshot", () => {
    expect(mruRank({ a: 5 }, "missing")).toBe(0);
  });

  it("returns 0 against an empty snapshot", () => {
    expect(mruRank({}, "anything")).toBe(0);
  });
});

describe("mru persistence without localStorage", () => {
  // The vitest node environment has no localStorage; the store must degrade
  // gracefully rather than throw.
  it("returns an empty snapshot when storage is unavailable", () => {
    expect(mruSnapshot()).toEqual({});
  });

  it("does not throw when recording a use", () => {
    expect(() => recordUse("some.command")).not.toThrow();
  });
});

afterEach(() => vi.unstubAllGlobals());

it.each(["null", "7", '"broken"', "[]", '{"settings.open":"bad"}'])(
  "keeps the palette usable with invalid stored ranking: %s",
  (stored) => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem });
    expect(mruRank(mruSnapshot(), "settings.open")).toBe(0);
    expect(() => recordUse("settings.open")).not.toThrow();
    expect(JSON.parse(setItem.mock.calls[0][1])["settings.open"]).toBeTypeOf(
      "number",
    );
  },
);

it("retains valid usage timestamps", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => '{"settings.open":123}',
  });
  expect(mruRank(mruSnapshot(), "settings.open")).toBe(123);
});
