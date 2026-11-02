import { requestContentSearch } from "@/modules/command-palette/hooks/requestContentSearch";
import { invoke } from "@tauri-apps/api/core";

const workspace = { kind: "local" } as const;
type WatchHandles = { directories: { handle: string }[]; files: { handle: string }[] };

/** Release exactly the handles acquired by this smoke run, including on failure. */
export async function withProfileWatch<T>(paths: string[], files: string[], work: () => Promise<T>): Promise<T> {
  const acquired = await invoke<WatchHandles>("fs_watch_add", { paths, files, workspace });
  const handles = [...acquired.directories, ...acquired.files].map((entry) => entry.handle);
  try {
    return await work();
  } finally {
    await invoke("watch_release", { handles });
  }
}

/** Exercise the same page-owned, explicitly cancelled searches as the sidebar. */
export async function profileGrepCancellation(root: string, delay: (ms: number) => Promise<void>): Promise<boolean> {
  const firstOwner = new AbortController();
  const first = requestContentSearch({ pattern: "zzzz-never-matches", root, maxResults: 50, workspace, channel: "sidebar" }, firstOwner.signal)
    .then(() => false, (error: unknown) => error === firstOwner.signal.reason);
  await delay(10);
  firstOwner.abort();
  const second = await requestContentSearch({ pattern: "zzzz-never-matches-either", root, maxResults: 50, workspace, channel: "sidebar" }, new AbortController().signal);
  return (await first) && !second.cancelled;
}
