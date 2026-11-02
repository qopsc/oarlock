import { describe, expect, it } from "vitest";
import { type PreviewStatus, previewAfterRead } from "./previewStatus";

const text = (content: string) =>
  ({
    ok: true,
    result: { kind: "text", content, size: content.length },
  }) as const;

describe("previewAfterRead", () => {
  it("shows the first read", () => {
    expect(previewAfterRead({ kind: "loading" }, text("# A"))).toEqual({
      kind: "ready",
      content: "# A",
    });
  });

  it("takes new content on a refresh and keeps the object when unchanged", () => {
    const ready: PreviewStatus = { kind: "ready", content: "# A" };
    expect(previewAfterRead(ready, text("# B"))).toEqual({
      kind: "ready",
      content: "# B",
    });
    expect(previewAfterRead(ready, text("# A"))).toBe(ready);
  });

  it("keeps the rendered file but marks failed refreshes until a successful read", () => {
    const ready: PreviewStatus = { kind: "ready", content: "# A" };
    const stale = previewAfterRead(ready, { ok: false, error: "ENOENT" });
    expect(stale).toEqual({ kind: "ready", content: "# A", refreshError: "ENOENT" });
    expect(previewAfterRead(stale, { ok: false, error: "EACCES" })).toEqual({
      kind: "ready", content: "# A", refreshError: "EACCES",
    });
    expect(previewAfterRead(stale, text("# A"))).toEqual(ready);
    expect(
      previewAfterRead({ kind: "loading" }, { ok: false, error: "ENOENT" }),
    ).toEqual({ kind: "error", message: "ENOENT" });
  });

  it("reports files it cannot render", () => {
    expect(
      previewAfterRead(
        { kind: "loading" },
        { ok: true, result: { kind: "toolarge", size: 20, limit: 10 } },
      ),
    ).toEqual({ kind: "toolarge", size: 20, limit: 10 });
  });
});
