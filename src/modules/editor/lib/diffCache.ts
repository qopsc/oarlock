import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace/env";
import {
  type GitDiffContentResult,
  native,
  createNative,
} from "@/modules/ai/lib/native";
import { currentWorkspaceScopeKey } from "@/modules/workspace";

const DIFF_CACHE_LIMIT = 6;
const inflight = new Map<string, Promise<GitDiffContentResult>>();
const cache = new Map<string, GitDiffContentResult>();
const listeners = new Map<string, Set<() => void>>();

export function onDiffInvalidated(
  key: string,
  callback: () => void,
): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(callback);
  return () => {
    set.delete(callback);
    if (set.size === 0) listeners.delete(key);
  };
}

function touch(key: string, value: GitDiffContentResult) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DIFF_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getCachedDiff(key: string): GitDiffContentResult | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

export function invalidateDiff(key: string): void {
  cache.delete(key);
  inflight.delete(key);
  for (const callback of listeners.get(key) ?? []) callback();
}

function scope(workspace?: WorkspaceEnv): string {
  return workspace ? workspaceScopeKey(workspace) : currentWorkspaceScopeKey();
}

function invalidatePrefix(parts: string[]): void {
  // JSON tuples preserve field boundaries even when paths contain delimiters.
  const prefix = `${JSON.stringify(parts).slice(0, -1)},`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  for (const key of inflight.keys())
    if (key.startsWith(prefix)) inflight.delete(key);
  for (const [key, callbacks] of listeners) {
    if (key.startsWith(prefix)) for (const callback of callbacks) callback();
  }
}

export function invalidateRepoDiffs(
  repoRoot: string,
  workspace?: WorkspaceEnv,
): void {
  invalidatePrefix([scope(workspace), repoRoot]);
}

/** Invalidate every rename-source variant of this file, including pending reads. */
export function invalidateWorkingDiff(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
  workspace?: WorkspaceEnv,
): void {
  invalidatePrefix([scope(workspace), repoRoot, "w", mode, path]);
}

export function workingDiffKey(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
  workspace?: WorkspaceEnv,
  originalPath: string | null = null,
): string {
  return JSON.stringify([
    scope(workspace),
    repoRoot,
    "w",
    mode,
    path,
    originalPath,
  ]);
}

export function commitDiffKey(
  repoRoot: string,
  sha: string,
  path: string,
  workspace?: WorkspaceEnv,
  originalPath: string | null = null,
): string {
  return JSON.stringify([
    scope(workspace),
    repoRoot,
    "c",
    sha,
    path,
    originalPath,
  ]);
}

export async function fetchWorkingDiff(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
  originalPath: string | null,
  workspace?: WorkspaceEnv,
): Promise<GitDiffContentResult> {
  const key = workingDiffKey(repoRoot, path, mode, workspace, originalPath);
  const cached = getCachedDiff(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const client = workspace ? createNative(() => workspace) : native;
  const p = client
    .gitDiffContent(repoRoot, path, mode === "+", originalPath)
    .then((res) => {
      if (inflight.get(key) === p) touch(key, res);
      return res;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export async function fetchCommitDiff(
  repoRoot: string,
  sha: string,
  path: string,
  originalPath: string | null,
  workspace?: WorkspaceEnv,
): Promise<GitDiffContentResult> {
  const key = commitDiffKey(repoRoot, sha, path, workspace, originalPath);
  const cached = getCachedDiff(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const client = workspace ? createNative(() => workspace) : native;
  const p = client
    .gitCommitFileDiff(repoRoot, sha, path, originalPath)
    .then((res) => {
      if (inflight.get(key) === p) touch(key, res);
      return res;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
