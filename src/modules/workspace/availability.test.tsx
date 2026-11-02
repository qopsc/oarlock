import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));
import {
  availableWorkspaceTabs,
  assertWorkspaceAvailable,
  workspaceUnavailableReason,
} from "./availability";
import { WorkspaceOwner } from "./owner";
const env = { kind: "wsl", distro: "Ubuntu" } as const;
it("keeps unavailable spaces and tabs stored while excluding their mounted resources", () => {
  const spaces = [
    { id: "wsl", env },
    { id: "local", env: { kind: "local" } as const },
  ];
  const tabs = [
    { spaceId: "wsl", id: 1 },
    { spaceId: "local", id: 2 },
  ];
  expect(availableWorkspaceTabs(tabs, spaces, false)).toEqual([tabs[1]]);
  expect(tabs).toHaveLength(2);
  expect(spaces[0].env).toBe(env);
  expect(availableWorkspaceTabs(tabs, spaces, true)).toBe(tabs);
  expect(workspaceUnavailableReason(env, false)).toContain("kept");
  expect(() => assertWorkspaceAvailable(env)).toThrow("unavailable");
  expect(() => assertWorkspaceAvailable({ kind: "local" })).not.toThrow();
});
it("does not mount a child which could start a process or read files in an unavailable environment", () => {
  const start = vi.fn(() => createElement("span", null, "started"));
  const html = renderToString(
    <WorkspaceOwner env={env}>{createElement(start)}</WorkspaceOwner>,
  );
  expect(html).toContain("unavailable");
  expect(start).not.toHaveBeenCalled();
  renderToString(
    <WorkspaceOwner env={{ kind: "local" }}>
      {createElement(start)}
    </WorkspaceOwner>,
  );
  expect(start).toHaveBeenCalledOnce();
});
