import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { PreviewTab } from "@/modules/tabs";
import { PreviewStack } from "./PreviewStack";

vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: (select: (state: { activeId: string }) => unknown) =>
    select({ activeId: "current" }),
}));
vi.mock("./PreviewPane", () => ({
  PreviewPane: ({
    visible,
    ownerKey,
  }: {
    visible: boolean;
    ownerKey: string;
  }) => <div data-visible={visible} data-owner={ownerKey} />,
}));

it.each([
  ["current", 1, true],
  ["other", 1, false],
  ["current", 2, false],
] as const)(
  "binds preview visibility to space %s and active tab %s",
  (spaceId, activeId, visible) => {
    const tab: PreviewTab = {
      id: 1,
      kind: "preview",
      title: "Preview",
      url: "http://localhost:3000",
      spaceId,
    };
    const html = renderToString(
      <PreviewStack
        tabs={[tab]}
        activeId={activeId}
        onUrlChange={() => {}}
        registerHandle={() => {}}
      />,
    );
    expect(html).toContain(`data-visible="${visible}"`);
    expect(html).toContain(`data-owner="${spaceId}"`);
  },
);
