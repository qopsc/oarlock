import type { Tab } from "@/modules/tabs";
import { describe, expect, it } from "vitest";
import { fileWatchTargets } from "./fileWatchTargets";

describe("fileWatchTargets", () => {
  it("watches open editor and rendered Markdown files", () => {
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "editor",
        spaceId: "s",
        title: "a.ts",
        path: "/repo/src/a.ts",
        dirty: false,
        preview: false,
      },
      {
        id: 2,
        kind: "markdown",
        spaceId: "s",
        title: "README.md",
        path: "/repo/README.md",
      },
      {
        id: 3,
        kind: "terminal",
        spaceId: "s",
        title: "sh",
        paneTree: { kind: "leaf", id: 4 },
        activeLeafId: 4,
      },
    ];
    expect(fileWatchTargets(tabs)).toEqual({
      dirs: new Set(["/repo/src", "/repo"]),
      files: new Set(["/repo/src/a.ts", "/repo/README.md"]),
    });
  });
});

it("releases a detached draft's coverage without dropping a replacement editor's watch", () => {
  const draft: Tab = {
    id: 1,
    kind: "editor",
    spaceId: "s",
    title: "draft",
    path: "/repo/a.ts",
    dirty: true,
    preview: false,
    detached: true,
  };
  expect(fileWatchTargets([draft])).toEqual({
    dirs: new Set(),
    files: new Set(),
  });
  expect(
    fileWatchTargets([draft, { ...draft, id: 2, detached: false }]),
  ).toEqual({ dirs: new Set(["/repo"]), files: new Set(["/repo/a.ts"]) });
});
