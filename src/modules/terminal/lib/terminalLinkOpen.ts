import type { WorkspaceEnv } from "@/modules/workspace/env";

type LinkNavigation = {
  readonly spaceId: string;
  readonly tabId: number | null;
  readonly controller: AbortController;
};
let navigation: LinkNavigation | null = null;

/** Shared by delayed terminal navigation and path-drop preparation. */
export function captureTerminalNavigation(): () => boolean {
  const current = navigation;
  return () => current !== null && !current.controller.signal.aborted;
}

/** The quick terminal has no workspace navigation, but still has an owner. */
export function captureTerminalInputNavigation(): () => boolean {
  const current = navigation;
  return () => current ? !current.controller.signal.aborted : navigation === null;
}

/** Own work that starts while a new terminal tab is being mounted. */
export function captureNewTerminalNavigation(tabId: number) {
  let live = true;
  let target: LinkNavigation | null = navigation?.tabId === tabId ? navigation : null;
  let previous = navigation;
  let invalid = previous === null;
  const changed = () => {
    if (target) { invalid = true; return; }
    queueMicrotask(() => {
      if (!live || invalid) return;
      if (!navigation || navigation.tabId !== tabId) { invalid = true; return; }
      target = navigation;
      previous = target;
      target.controller.signal.addEventListener("abort", changed, { once: true });
    });
  };
  previous?.controller.signal.addEventListener("abort", changed, { once: true });
  return {
    active: () => live && !invalid && target !== null &&
      target === navigation && !target.controller.signal.aborted,
    dispose: () => {
      live = false;
      previous?.controller.signal.removeEventListener("abort", changed);
    },
  };
}

/** Each committed tab/space change permanently invalidates earlier clicks. */
export function setTerminalLinkNavigation(
  spaceId: string,
  tabId: number | null,
): () => void {
  navigation?.controller.abort();
  const current = { spaceId, tabId, controller: new AbortController() };
  navigation = current;
  return () => {
    current.controller.abort();
    if (navigation === current) navigation = null;
  };
}

export type TerminalLinkOperation = {
  readonly workspace: WorkspaceEnv;
  readonly spaceId: string;
  readonly active: () => boolean;
};

/**
 * Opens a link clicked in a terminal: URLs in the preview when the app takes
 * them (`setTerminalPreviewOpener`), otherwise the browser; files in the
 * editor (at their line), local folders in the system file manager. The
 * resolving code loads on the first click.
 */
export function openTerminalLink(
  uri: string,
  cwd: string | null,
  onExternalSettled: () => void,
  owner: { readonly workspace: WorkspaceEnv; readonly active: () => boolean },
): Promise<void> {
  const current = navigation;
  if (!current || !owner.active()) return Promise.resolve();
  const operation: TerminalLinkOperation = {
    workspace: owner.workspace,
    spaceId: current.spaceId,
    active: () => owner.active() && !current.controller.signal.aborted,
  };
  return import("./terminalLinkTargets").then((links) =>
    links.openTerminalLinkTarget(uri, cwd, onExternalSettled, operation),
  );
}

let previewOpener: ((url: string) => boolean) | null = null;

/**
 * The app decides whether a URL clicked in a terminal opens in its preview
 * tab (returning true) or goes to the system browser.
 */
export function setTerminalPreviewOpener(
  opener: ((url: string) => boolean) | null,
): void {
  previewOpener = opener;
}

/** Opens a link in the preview; false when it belongs in the browser. */
export function openTerminalPreview(url: string): boolean {
  return previewOpener?.(url) ?? false;
}

type FileOpener = (
  path: string,
  line: number | null,
  column: number | null,
  spaceId: string,
) => void;

let fileOpener: FileOpener | null = null;

/** The app's editor registers how to open a file (at a line) from a terminal. */
export function setTerminalFileOpener(opener: FileOpener | null): void {
  fileOpener = opener;
}

/** Opens a file in the editor; false when no editor is registered. */
export function openTerminalFile(
  path: string,
  line: number | null,
  column: number | null,
  spaceId: string,
): boolean {
  if (!fileOpener) return false;
  fileOpener(path, line, column, spaceId);
  return true;
}
