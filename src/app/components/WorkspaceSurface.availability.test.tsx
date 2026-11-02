import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));
const record = vi.hoisted(() => ({
  seen: [] as number[],
  spaces: [
    { id: "wsl", env: { kind: "wsl", distro: "Ubuntu" } },
    { id: "local", env: { kind: "local" } },
  ],
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: (select: (s: typeof record) => unknown) => select(record),
}));
vi.mock("@/modules/terminal", () => ({
  TerminalStack: ({ tabs }: { tabs: { id: number }[] }) => {
    record.seen.push(...tabs.map((t) => t.id));
    return null;
  },
}));
vi.mock("@/modules/editor", () => ({
  AiDiffStack: () => null,
  EditorStack: () => null,
  GitDiffStack: () => null,
}));
vi.mock("@/modules/git-history", () => ({ GitHistoryStack: () => null }));
vi.mock("@/modules/markdown", () => ({ MarkdownStack: () => null }));
vi.mock("@/modules/preview", () => ({ PreviewStack: () => null }));
import { WorkspaceSurface } from "./WorkspaceSurface";
it("shows an unavailable active space without unmounting other spaces' live terminals", () => {
  const tabs = [
    { id: 1, kind: "terminal", spaceId: "wsl" },
    { id: 2, kind: "terminal", spaceId: "local" },
  ];
  const html = renderToString(
    createElement(WorkspaceSurface, {
      tabs,
      activeTab: tabs[0],
      activeId: 1,
    } as ComponentProps<typeof WorkspaceSurface>),
  );
  expect(html).toContain("Space unavailable");
  expect(record.seen).toEqual([2]);
  expect(tabs).toHaveLength(2);
});
