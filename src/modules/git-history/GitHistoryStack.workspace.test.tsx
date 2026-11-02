import { expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { Tab } from "@/modules/tabs";
const fake = vi.hoisted(() => ({
  seen: vi.fn(),
  env: { kind: "wsl", distro: "Ubuntu" },
}));
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: (select: (state: unknown) => unknown) =>
    select({
      spaces: [
        { id: "a", env: fake.env },
        { id: "b", env: { kind: "wsl", distro: "Debian" } },
      ],
    }),
}));
vi.mock("./GitHistoryPane", async () => {
  const { useOwnedWorkspace } = await import("@/modules/workspace/owner");
  return {
    GitHistoryPane: () => {
      fake.seen(useOwnedWorkspace());
      return null;
    },
  };
});
import { GitHistoryStack } from "./GitHistoryStack";
it("binds history to the tab's space instead of the ambient environment", () => {
  renderToString(
    <GitHistoryStack
      tabs={[
        { kind: "git-history", id: 1, spaceId: "a", repoRoot: "/repo" } as Tab,
      ]}
      activeId={1}
      onOpenCommitFile={() => {}}
    />,
  );
  expect(fake.seen).toHaveBeenCalledWith(fake.env);
});
