import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMock = vi.hoisted(() => ({
  gitDiffContent: vi.fn(),
  gitCommitFileDiff: vi.fn(),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: nativeMock,
  createNative: () => nativeMock,
}));

const workspaceMock = vi.hoisted(() => ({
  currentWorkspaceScopeKey: vi.fn(() => "scope"),
}));

vi.mock("@/modules/workspace", () => workspaceMock);

import type { GitDiffContentResult } from "@/modules/ai/lib/native";

function result(modifiedContent: string): GitDiffContentResult {
  return {
    originalContent: "",
    modifiedContent,
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  };
}

async function loadModule() {
  return await import("./diffCache");
}

describe("git diff content cache", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeMock.gitDiffContent.mockReset();
    nativeMock.gitCommitFileDiff.mockReset();
    workspaceMock.currentWorkspaceScopeKey.mockClear();
    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("scope");
  });

  it("scopes diff keys by workspace, repo, and kind", async () => {
    const { workingDiffKey, commitDiffKey } = await loadModule();

    expect(workingDiffKey("/repo", "src/a.ts", "-")).toBe(
      JSON.stringify(["scope", "/repo", "w", "-", "src/a.ts", null]),
    );
    expect(commitDiffKey("/repo", "abc123", "src/a.ts")).toBe(
      JSON.stringify(["scope", "/repo", "c", "abc123", "src/a.ts", null]),
    );
  });

  it("serves repeated reads of the same file from cache", async () => {
    const { fetchWorkingDiff } = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("- line"));

    await fetchWorkingDiff("/repo", "a.ts", "-", null);
    const second = await fetchWorkingDiff("/repo", "a.ts", "-", null);

    expect(second.modifiedContent).toBe("- line");
    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent reads of the same diff into one backend call", async () => {
    const { fetchWorkingDiff } = await loadModule();
    let release: ((v: GitDiffContentResult) => void) | undefined;
    nativeMock.gitDiffContent.mockReturnValue(
      new Promise<GitDiffContentResult>((r) => {
        release = r;
      }),
    );

    const first = fetchWorkingDiff("/repo", "a.ts", "-", null);
    const second = fetchWorkingDiff("/repo", "a.ts", "-", null);
    release?.(result("shared"));

    expect(await first).toBe(await second);
    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry past six", async () => {
    const mod = await loadModule();
    nativeMock.gitDiffContent.mockImplementation((_root, path: string) =>
      Promise.resolve(result(`body ${path}`)),
    );

    for (let i = 0; i < 6; i++) {
      await mod.fetchWorkingDiff("/repo", `f${i}.ts`, "-", null);
    }
    await mod.fetchWorkingDiff("/repo", "new.ts", "-", null);

    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "f0.ts", "-")),
    ).toBeUndefined();
    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "f1.ts", "-")),
    ).toBeDefined();
  });

  it("keeps an entry that was just read when the limit overflows", async () => {
    const { fetchWorkingDiff, getCachedDiff, workingDiffKey } =
      await loadModule();
    nativeMock.gitDiffContent.mockImplementation((_root, path: string) =>
      Promise.resolve(result(`body ${path}`)),
    );

    for (let i = 0; i < 6; i++) {
      await fetchWorkingDiff("/repo", `f${i}.ts`, "-", null);
    }
    getCachedDiff(workingDiffKey("/repo", "f0.ts", "-"));
    await fetchWorkingDiff("/repo", "new.ts", "-", null);

    expect(getCachedDiff(workingDiffKey("/repo", "f0.ts", "-"))).toBeDefined();
    expect(
      getCachedDiff(workingDiffKey("/repo", "f1.ts", "-")),
    ).toBeUndefined();
  });

  it("does not retry or cache a failed backend call", async () => {
    const { fetchWorkingDiff } = await loadModule();
    nativeMock.gitDiffContent
      .mockRejectedValueOnce(new Error("git failed"))
      .mockResolvedValueOnce(result("recovered"));

    await expect(fetchWorkingDiff("/repo", "a.ts", "-", null)).rejects.toThrow(
      "git failed",
    );
    await expect(fetchWorkingDiff("/repo", "a.ts", "-", null)).resolves.toEqual(
      result("recovered"),
    );
    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the current workspace scope for a repo root", async () => {
    const mod = await loadModule();
    const { fetchWorkingDiff, getCachedDiff, workingDiffKey } = mod;
    nativeMock.gitDiffContent.mockImplementation((_root, path: string) =>
      Promise.resolve(result(`body ${path}`)),
    );

    await fetchWorkingDiff("/repo-a", "x.ts", "-", null);

    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("other");
    await fetchWorkingDiff("/repo-a", "x.ts", "-", null);
    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("scope");

    const { invalidateRepoDiffs } = mod;
    invalidateRepoDiffs("/repo-a");

    expect(
      getCachedDiff(workingDiffKey("/repo-a", "x.ts", "-")),
    ).toBeUndefined();

    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("other");
    expect(getCachedDiff(workingDiffKey("/repo-a", "x.ts", "-"))).toBeDefined();
  });

  it("keeps working-tree and commit diffs under separate namespaces", async () => {
    const { fetchWorkingDiff, fetchCommitDiff } = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("work"));
    nativeMock.gitCommitFileDiff.mockResolvedValue(result("commit"));

    await fetchWorkingDiff("/repo", "a.ts", "+", null);
    await fetchCommitDiff("/repo", "sha1", "a.ts", null);

    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(1);
    expect(nativeMock.gitCommitFileDiff).toHaveBeenCalledWith(
      "/repo",
      "sha1",
      "a.ts",
      null,
    );
  });
});

it("keeps explicit workspace diff caches separate from the active workspace", async () => {
  const { fetchWorkingDiff } = await import("./diffCache");
  const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
  const debian = { kind: "wsl", distro: "Debian" } as const;
  nativeMock.gitDiffContent
    .mockResolvedValueOnce(result("ubuntu"))
    .mockResolvedValueOnce(result("debian"));
  const a = await fetchWorkingDiff("/repo", "same.ts", "-", null, ubuntu);
  const b = await fetchWorkingDiff("/repo", "same.ts", "-", null, debian);
  expect(a.modifiedContent).toBe("ubuntu");
  expect(b.modifiedContent).toBe("debian");
});

it("does not revive invalidated content or reuse its in-flight request", async () => {
  vi.resetModules();
  nativeMock.gitDiffContent.mockReset();
  const mod = await loadModule();
  let finishOld!: (value: GitDiffContentResult) => void;
  let finishNew!: (value: GitDiffContentResult) => void;
  nativeMock.gitDiffContent
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
  const first = mod.fetchWorkingDiff("/repo", "a.ts", "-", null);
  const key = mod.workingDiffKey("/repo", "a.ts", "-");
  mod.invalidateDiff(key);
  const second = mod.fetchWorkingDiff("/repo", "a.ts", "-", null);
  expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(2);
  finishOld(result("old"));
  await first;
  expect(mod.getCachedDiff(key)).toBeUndefined();
  const third = mod.fetchWorkingDiff("/repo", "a.ts", "-", null);
  expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(2);
  finishNew(result("new"));
  expect(await second).toEqual(result("new"));
  expect(await third).toEqual(result("new"));
  expect(mod.getCachedDiff(key)).toEqual(result("new"));
});

it("invalidates a completed command's own workspace after navigation", async () => {
  vi.resetModules();
  nativeMock.gitDiffContent.mockReset();
  const mod = await loadModule();
  const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
  const debian = { kind: "wsl", distro: "Debian" } as const;
  nativeMock.gitDiffContent.mockResolvedValue(result("cached"));
  await mod.fetchWorkingDiff("/repo", "a.ts", "-", null, ubuntu);
  await mod.fetchWorkingDiff("/repo", "a.ts", "-", null, debian);
  workspaceMock.currentWorkspaceScopeKey.mockReturnValue("wsl:Debian");
  mod.invalidateRepoDiffs("/repo", ubuntu);
  expect(
    mod.getCachedDiff(mod.workingDiffKey("/repo", "a.ts", "-", ubuntu)),
  ).toBeUndefined();
  expect(
    mod.getCachedDiff(mod.workingDiffKey("/repo", "a.ts", "-", debian)),
  ).toBeDefined();
});

it("does not confuse repository and filename separators", async () => {
  const { workingDiffKey } = await loadModule();
  expect(workingDiffKey("/repo", "a|w|-|b", "-")).not.toBe(
    workingDiffKey("/repo|w|-|a", "b", "-"),
  );
});

it("does not reuse a diff with a different rename source", async () => {
  vi.resetModules();
  nativeMock.gitDiffContent.mockReset();
  nativeMock.gitDiffContent
    .mockResolvedValueOnce(result("from-a"))
    .mockResolvedValueOnce(result("from-b"));
  const { fetchWorkingDiff } = await loadModule();
  await fetchWorkingDiff("/repo", "new.txt", "+", "a.txt");
  expect(
    (await fetchWorkingDiff("/repo", "new.txt", "+", "b.txt")).modifiedContent,
  ).toBe("from-b");
});

it("invalidates all rename variants while preserving adjacent files and repositories", async () => {
  vi.resetModules();
  nativeMock.gitDiffContent.mockReset().mockResolvedValue(result("cached"));
  const mod = await loadModule();
  await mod.fetchWorkingDiff("/repo", "new.txt", "+", "a.txt");
  await mod.fetchWorkingDiff("/repo", "new.txt", "+", "b.txt");
  await mod.fetchWorkingDiff("/repo", "new.txt-more", "+", null);
  await mod.fetchWorkingDiff("/repo|w|+|new.txt", "other", "+", null);
  mod.invalidateWorkingDiff("/repo", "new.txt", "+");
  for (const original of ["a.txt", "b.txt"]) {
    expect(
      mod.getCachedDiff(
        mod.workingDiffKey("/repo", "new.txt", "+", undefined, original),
      ),
    ).toBeUndefined();
  }
  expect(
    mod.getCachedDiff(mod.workingDiffKey("/repo", "new.txt-more", "+")),
  ).toBeDefined();
  expect(
    mod.getCachedDiff(mod.workingDiffKey("/repo|w|+|new.txt", "other", "+")),
  ).toBeDefined();
});
