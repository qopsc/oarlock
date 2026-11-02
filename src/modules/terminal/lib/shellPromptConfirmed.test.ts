import { expect, it, vi } from "vitest";
import { foregroundJob, shellPromptConfirmed } from "./shellPromptConfirmed";

it("does not query the process check for an unconfirmed WSL pane", async () => {
  for (const state of [
    { promptSeen: false, alternateScreen: false },
    { promptSeen: true, alternateScreen: true },
  ]) {
    const query = vi.fn(async () => false);
    expect(await foregroundJob(ubuntu, state, query)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  }
});

it("asks the process check for a confirmed WSL pane and for any other pane", async () => {
  const query = vi.fn(async () => false);
  expect(await foregroundJob(ubuntu, { promptSeen: true, alternateScreen: false }, query)).toBe(false);
  expect(await foregroundJob(local, { promptSeen: false, alternateScreen: true }, query)).toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
});

const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
const local = { kind: "local" } as const;

it("leaves non-WSL panes to the process check", () => {
  expect(shellPromptConfirmed(local, { promptSeen: false, alternateScreen: true })).toBe(true);
});

it("does not trust a WSL pane without a prompt end from shell integration", () => {
  expect(shellPromptConfirmed(ubuntu, { promptSeen: false, alternateScreen: false })).toBe(false);
});

it("does not trust a WSL pane in the alternate screen or without a model", () => {
  expect(shellPromptConfirmed(ubuntu, { promptSeen: true, alternateScreen: true })).toBe(false);
  expect(shellPromptConfirmed(ubuntu, { promptSeen: true, alternateScreen: undefined })).toBe(false);
});

it("trusts a WSL pane at a reported prompt on the main screen", () => {
  expect(shellPromptConfirmed(ubuntu, { promptSeen: true, alternateScreen: false })).toBe(true);
});
