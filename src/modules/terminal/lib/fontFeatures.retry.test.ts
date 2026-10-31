import { afterEach, expect, it, vi } from "vitest";
const core = vi.hoisted(() => ({ invoke: vi.fn(), convertFileSrc: (path: string) => `asset://localhost${path}` }));
vi.mock("@tauri-apps/api/core", () => core);
import { subscribeFontFeatures, withFontFeatures } from "./fontFeatures";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("retries a failed installed-font lookup after returning to the window", async () => {
  vi.useFakeTimers();
  const window = new EventTarget();
  vi.stubGlobal("window", window);
  vi.stubGlobal("FontFace", class {});
  vi.stubGlobal("document", { baseURI: "https://app.test/", styleSheets: [], fonts: { add: () => undefined } });
  core.invoke.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce([
    { path: "/fonts/Retry-Regular.ttf", weight: 400, style: "normal", stretch: 100 },
  ]);
  const changed = vi.fn();
  const stop = subscribeFontFeatures(changed);
  const stack = '"Retry Font", monospace';
  withFontFeatures(stack, '"ss01" 1');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(core.invoke).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("focus"));
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  window.dispatchEvent(new Event("focus"));
  expect(changed).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  expect(changed).toHaveBeenCalledOnce();
  withFontFeatures(stack, '"ss01" 1');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(core.invoke).toHaveBeenCalledTimes(2);
  expect(withFontFeatures(stack, '"ss01" 1')).toContain("Retry Font (Oarlock features");
  stop();
});
