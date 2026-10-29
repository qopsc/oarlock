import { expect, it } from "vitest";
import { captureNewTerminalNavigation, setTerminalLinkNavigation } from "./terminalLinkOpen";

it("binds a new terminal to its first navigation and invalidates a switch away and back", async () => {
  setTerminalLinkNavigation("space", 1);
  const owner = captureNewTerminalNavigation(2);
  setTerminalLinkNavigation("space", 2);
  await Promise.resolve();
  expect(owner.active()).toBe(true);
  setTerminalLinkNavigation("space", 3);
  setTerminalLinkNavigation("space", 2);
  await Promise.resolve();
  expect(owner.active()).toBe(false);
  owner.dispose();
});

it("rejects navigation to a different tab before the new terminal mounts", async () => {
  setTerminalLinkNavigation("space", 1);
  const owner = captureNewTerminalNavigation(2);
  setTerminalLinkNavigation("space", 3);
  await Promise.resolve();
  setTerminalLinkNavigation("space", 2);
  await Promise.resolve();
  expect(owner.active()).toBe(false);
  owner.dispose();
});
