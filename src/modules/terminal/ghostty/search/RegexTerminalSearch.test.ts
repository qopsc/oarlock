import { readFile } from "node:fs/promises";
import { OarlockGhostty } from "@oarlock/ghostty-core/adapted";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AdaptedGhosttyTerminalModel } from "../AdaptedGhosttyTerminalModel";
import { RegexTerminalSearch } from "./RegexTerminalSearch";
import { compileTerminalPattern, matchLine } from "./regexEvaluation";
import type { RegexRunner } from "./regexWorkerClient";
const inlineRunner = (): RegexRunner => ({
  run: async (batch) => {
    const regex = compileTerminalPattern(batch.pattern);
    if (!regex) throw new Error("Invalid regex");
    return batch.lines.flatMap((row, index) =>
      matchLine(row, batch.firstLine + index, regex, batch.limit),
    );
  },
  dispose: () => {},
});
async function scan(search: RegexTerminalSearch, budget: number) {
  let status = search.step(budget);
  while (!status.complete) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    status = search.step(budget);
  }
  return status;
}

describe("regex terminal search patterns", () => {
  it("does not evaluate another match after reaching the cap", () => {
    const regex = /x/g;
    const exec = vi.spyOn(regex, "exec");
    expect(matchLine(["x", "x"], 0, regex, 1)).toHaveLength(1);
    expect(exec).toHaveBeenCalledOnce();
  });
  it("is smart-case and rejects invalid or empty-matching patterns", () => {
    expect(compileTerminalPattern("err")?.flags).toContain("i");
    expect(compileTerminalPattern("Err")?.flags).not.toContain("i");
    expect(compileTerminalPattern("(")).toBeNull();
    expect(compileTerminalPattern("x*")).toBeNull();
    expect(compileTerminalPattern("")).toBeNull();
  });

  it("advances zero-width matches past complete Unicode characters", () => {
    const cells = ["\u{1f600}", "", "a"];
    for (const pattern of ["(?=.)", "(?=.)|a"]) {
      const regex = compileTerminalPattern(pattern);
      if (!regex) throw new Error("Expected a valid regex");
      expect(matchLine(cells, 0, regex, 10)).toEqual([]);
    }
    const mixed = compileTerminalPattern("(?=\\p{Emoji})|a");
    if (!mixed) throw new Error("Expected a valid regex");
    expect(matchLine(cells, 0, mixed, 10)).toEqual([
      { line: 0, startColumn: 2, endColumn: 3 },
    ]);
  });

  it("maps matches to columns across wide characters", () => {
    const cells = ["a", "日", "", "b", "1", "2", " "];
    const regex = compileTerminalPattern("日b|\\d+");
    expect(regex && matchLine(cells, 7, regex, 10)).toEqual([
      { line: 7, startColumn: 1, endColumn: 4 },
      { line: 7, startColumn: 4, endColumn: 6 },
    ]);
    const wide = compileTerminalPattern("a日");
    expect(wide && matchLine(cells, 0, wide, 10)).toEqual([
      { line: 0, startColumn: 0, endColumn: 3 },
    ]);
  });
});

describe("regex terminal search over a buffer", () => {
  let core: OarlockGhostty;
  beforeAll(async () => {
    const file = await readFile(
      new URL(
        "../../../../../packages/ghostty-core/adapted/ghostty-vt.wasm",
        import.meta.url,
      ),
    );
    core = await OarlockGhostty.loadBytes(Uint8Array.from(file).buffer);
  });

  it("scans history in steps, selects matches and scrolls to them", async () => {
    const model = new AdaptedGhosttyTerminalModel(core, {
      backend: "ghostty-webgpu",
      cols: 40,
      rows: 5,
    });
    try {
      for (let line = 0; line < 30; line++) {
        model.write(
          new TextEncoder().encode(
            `line ${line} ${line % 10 === 0 ? "ERROR 42" : "ok"}\r\n`,
          ),
        );
      }
      const search = new RegexTerminalSearch(model, () => {}, inlineRunner);
      expect(search.setQuery("error \\d+").pending).toBe(true);
      let status = search.step(10);
      expect(status.complete).toBe(false);
      status = await scan(search, 10);
      expect(status.totalMatches).toBe(3);

      status = search.select("previous");
      // The viewport shows the newest lines; "previous" finds the last match above.
      expect(status.selectedIndex).toBe(2);
      const top = model.viewportOriginLine();
      const spans = search.viewportMatches();
      expect(spans).toEqual([
        expect.objectContaining({
          startColumn: 8,
          endColumn: 16,
          selected: true,
        }),
      ]);
      expect(spans[0].row + top).toBe(20);

      status = search.select("previous");
      expect(status.selectedIndex).toBe(1);
      // Line 10 scrolled into view.
      expect(model.viewportOriginLine()).toBeLessThanOrEqual(10);
      expect(model.viewportOriginLine() + 4).toBeGreaterThanOrEqual(10);

      // New output restarts the scan.
      model.write(new TextEncoder().encode("ERROR 7\r\n"));
      status = await scan(search, 100);
      expect(status.totalMatches).toBe(4);
      expect(status.selectedIndex).toBe(-1);
    } finally {
      model.dispose();
    }
  });
});
