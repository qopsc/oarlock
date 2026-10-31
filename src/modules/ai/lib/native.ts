import { discardAcrossWindows } from "@/modules/editor/lib/discardBridge";
import { invoke } from "@tauri-apps/api/core";
import {
  authorizationSettled,
  currentWorkspaceEnv,
  type WorkspaceEnv,
} from "@/modules/workspace";

/** A project's AGENTS.md as the user allowed it: its size in bytes and its
 *  whole text, or no text when it is larger than the run's model could take. */
export type ProjectMemory = { size: number; text: string | null };

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
  /** Set when the work tree is a linked worktree, not the main one. */
  linkedWorktree: GitLinkedWorktree | null;
};

export type GitLinkedWorktree = {
  /** The worktree's folder name. */
  name: string;
  /** Its main worktree's folder name (a bare repository's, without `.git`). */
  repositoryName: string;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

/** A ref on a commit, classified by its namespace in Rust, never by its name. */
export type GitLogRef = {
  kind: "head" | "branch" | "tag" | "remote";
  /** Without its namespace: `main`, `v1.0`, `origin/main`. */
  name: string;
  /** HEAD is here: the branch it is on, or HEAD itself when detached. */
  head: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  /** HEAD and its branch first, then branches, tags and remote branches. */
  refs: GitLogRef[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

/** A local branch. */
export type GitBranchEntry = {
  name: string;
  /** Another worktree that has the branch checked out, which no other one can. */
  worktreePath: string | null;
  isHead: boolean;
  isDetached: boolean;
};

/** One entry of `git worktree list`. */
export type GitWorktreeEntry = {
  path: string;
  /** Without `refs/heads/`; null when detached or bare. */
  branch: string | null;
  head: string | null;
  /** The main worktree (or the bare repository), always listed first. */
  isMain: boolean;
  isBare: boolean;
  /** The worktree the listing was made in. */
  isCurrent: boolean;
  /** The lock reason (possibly empty) when locked. */
  locked: string | null;
  /** Its folder is gone. */
  prunable: boolean;
};

export type GitBranchListResult = {
  branches: GitBranchEntry[];
  worktrees: GitWorktreeEntry[];
};

/**
 * A git command on a path the page names (the folder a terminal just moved
 * to, an open file) waits for that path's authorization in flight, as reads
 * and listings do, so right after a `cd` it never reaches the backend first
 * and is refused. A repository root needs no wait: the backend authorizes a
 * root when it finds one.
 */
export function createNative(
  environment: () => WorkspaceEnv = currentWorkspaceEnv,
) {
  function gitOnPath<T>(
    command: string,
    path: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const workspace = environment();
    return authorizationSettled(path, workspace).then(() =>
      invoke<T>(command, { ...args, workspace }),
    );
  }

  /**
   * Marks a file or shell call as the AI tools': the backend then applies their
   * own "access all folders" setting, never the app's. Every file and shell
   * call below carries it, and only the AI tools use them.
   */
  const AI_ORIGIN = { origin: "ai" } as const;

  return {
    workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
    readFile: (path: string) =>
      invoke<ReadResult>("fs_read_file", {
        path,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    /** The window's project AGENTS.md for a run in `root`, only while the user
     *  allows its current content (`project_memory_read`); null otherwise. Its
     *  text is null when it is larger than `limit` bytes. */
    readProjectMemory: (root: string, limit: number) =>
      invoke<ProjectMemory | null>("project_memory_read", {
        root,
        workspace: environment(),
        limit: Math.floor(limit),
      }),
    writeFile: (path: string, content: string) =>
      invoke<void>("fs_write_file", {
        path,
        content,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    canonicalize: (path: string) =>
      invoke<string>("fs_canonicalize", {
        path,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    createDir: (path: string) =>
      invoke<void>("fs_create_dir", {
        path,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    // AI tooling never sees dot-prefixed entries regardless of the user's
    // explorer preference — keeps .git / .env / .ssh out of agent context.
    readDir: (path: string) =>
      invoke<DirEntry[]>("fs_read_dir", {
        path,
        showHidden: false,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    grep: (params: {
      pattern: string;
      root: string;
      glob?: string[];
      caseInsensitive?: boolean;
      maxResults?: number;
    }) =>
      invoke<GrepResponse>("fs_grep", {
        pattern: params.pattern,
        root: params.root,
        glob: params.glob ?? null,
        caseInsensitive: params.caseInsensitive ?? null,
        maxResults: params.maxResults ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    glob: (params: { pattern: string; root: string; maxResults?: number }) =>
      invoke<GlobResponse>("fs_glob", {
        pattern: params.pattern,
        root: params.root,
        maxResults: params.maxResults ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    runCommand: (command: string, cwd?: string | null, timeoutSecs?: number) =>
      invoke<CommandOutput>("shell_run_command", {
        command,
        cwd: cwd ?? null,
        timeoutSecs: timeoutSecs ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),

    shellSessionOpen: (cwd?: string | null, chatId?: string | null) =>
      invoke<number>("shell_session_open", {
        chatId: chatId ?? null,
        cwd: cwd ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    shellSessionRun: (
      id: number,
      command: string,
      cwd?: string | null,
      timeoutSecs?: number,
    ) =>
      invoke<{
        stdout: string;
        stderr: string;
        exit_code: number | null;
        timed_out: boolean;
        truncated: boolean;
        cwd_after: string | null;
        cwd_error: string | null;
      }>("shell_session_run", {
        id,
        command,
        cwd: cwd ?? null,
        timeoutSecs: timeoutSecs ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    shellSessionClose: (id: number) =>
      invoke<void>("shell_session_close", { id }),
    shellBgKillChat: (chatId: string) =>
      invoke<void>("shell_bg_kill_chat", { chatId }),
    shellDetachedSpawn: (command: string, cwd?: string | null) =>
      invoke<number>("shell_detached_spawn", {
        command,
        cwd: cwd ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    shellBgSpawn: (
      command: string,
      cwd?: string | null,
      chatId?: string | null,
    ) =>
      invoke<number>("shell_bg_spawn", {
        command,
        chatId: chatId ?? null,
        cwd: cwd ?? null,
        workspace: environment(),
        ...AI_ORIGIN,
      }),
    shellBgLogs: (handle: number, sinceOffset?: number) =>
      invoke<{
        bytes: string;
        next_offset: number;
        dropped: number;
        exited: boolean;
        exit_code: number | null;
      }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
    shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
    shellBgList: () =>
      invoke<
        {
          handle: number;
          command: string;
          cwd: string | null;
          started_at_ms: number;
          exited: boolean;
          exit_code: number | null;
        }[]
      >("shell_bg_list"),
    gitResolveRepo: (cwd: string) =>
      gitOnPath<GitRepoInfo | null>("git_resolve_repo", cwd, { cwd }),
    /** Repositories inside a folder that is not one itself (children, grandchildren). */
    gitDiscoverRepos: (path: string) =>
      gitOnPath<string[]>("git_discover_repos", path, { path }),
    gitPanelSnapshot: (cwd: string) =>
      gitOnPath<GitPanelSnapshot>("git_panel_snapshot", cwd, { cwd }),
    gitStatus: (repoRoot: string) =>
      invoke<GitStatusSnapshot>("git_status", {
        repoRoot,
        workspace: environment(),
      }),
    gitAiStagedDiff: (repoRoot: string) =>
      invoke<GitDiffResult & { paths: string[] }>("git_ai_staged_diff", {
        repoRoot,
        workspace: environment(),
      }),
    gitDiff: (repoRoot: string, path: string | null, staged: boolean) =>
      invoke<GitDiffResult>("git_diff", {
        repoRoot,
        path,
        staged,
        workspace: environment(),
      }),
    gitFileBase: (path: string) =>
      gitOnPath<string | null>("git_file_base", path, { path }),
    gitDiffContent: (
      repoRoot: string,
      path: string,
      staged: boolean,
      originalPath?: string | null,
    ) =>
      invoke<GitDiffContentResult>("git_diff_content", {
        repoRoot,
        path,
        staged,
        originalPath: originalPath ?? null,
        workspace: environment(),
      }),
    gitStage: (repoRoot: string, paths: string[]) =>
      invoke<void>("git_stage", {
        repoRoot,
        paths,
        workspace: environment(),
      }),
    gitUnstage: (repoRoot: string, paths: string[]) =>
      invoke<void>("git_unstage", {
        repoRoot,
        paths,
        workspace: environment(),
      }),
    gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
      discardAcrossWindows(repoRoot, entries, environment()),
    gitCommit: (repoRoot: string, message: string) =>
      invoke<GitCommitResult>("git_commit", {
        repoRoot,
        message,
        workspace: environment(),
      }),
    gitFetch: (repoRoot: string) =>
      invoke<void>("git_fetch", {
        repoRoot,
        workspace: environment(),
      }),
    gitPullFfOnly: (repoRoot: string) =>
      invoke<void>("git_pull_ff_only", {
        repoRoot,
        workspace: environment(),
      }),
    gitPush: (repoRoot: string) =>
      invoke<GitPushResult>("git_push", {
        repoRoot,
        workspace: environment(),
      }),
    gitLog: (
      repoRoot: string,
      options?: { limit?: number; skip?: number; anchorSha?: string },
    ) =>
      invoke<GitLogEntry[]>("git_log", {
        repoRoot,
        limit: options?.limit ?? null,
        skip: options?.skip ?? null,
        anchorSha: options?.anchorSha ?? null,
        workspace: environment(),
      }),
    gitShowCommit: (repoRoot: string, sha: string) =>
      invoke<GitDiffResult>("git_show_commit", {
        repoRoot,
        sha,
        workspace: environment(),
      }),
    /** Undo the confirmed branch/commit; never redirect to a newly checked-out branch. */
    gitUndoCommit: (
      repoRoot: string,
      expectedHead: string,
      expectedBranch: string,
    ) =>
      invoke<void>("git_undo_commit", {
        repoRoot,
        expectedHead,
        expectedBranch,
        workspace: environment(),
      }),
    /** The first remote-tracking branch already containing `sha`, if any. */
    gitCommitOnRemote: (repoRoot: string, sha: string) =>
      invoke<string | null>("git_commit_on_remote", {
        repoRoot,
        sha,
        workspace: environment(),
      }),
    gitCommitFiles: (repoRoot: string, sha: string) =>
      invoke<GitCommitFileChange[]>("git_commit_files", {
        repoRoot,
        sha,
        workspace: environment(),
      }),
    gitCommitFileDiff: (
      repoRoot: string,
      sha: string,
      path: string,
      originalPath?: string | null,
    ) =>
      invoke<GitDiffContentResult>("git_commit_file_diff", {
        repoRoot,
        sha,
        path,
        originalPath: originalPath ?? null,
        workspace: environment(),
      }),
    gitRemoteUrl: (repoRoot: string, name?: string) =>
      invoke<string | null>("git_remote_url", {
        repoRoot,
        name: name ?? null,
        workspace: environment(),
      }),
    gitListBranches: (repoRoot: string) =>
      invoke<GitBranchListResult>("git_list_branches", {
        repoRoot,
        workspace: environment(),
      }),
    gitCheckoutBranch: (repoRoot: string, branch: string) =>
      invoke<void>("git_checkout_branch", {
        repoRoot,
        branch,
        workspace: environment(),
      }),
  };
}

export const native = createNative();
