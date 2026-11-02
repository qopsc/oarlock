import { expect, it } from "vitest";
import { shellPromptConfirmed } from "./shellPromptConfirmed";

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
