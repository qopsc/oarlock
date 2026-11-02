# Batch G design: O-06, restore OS file drops into plain terminals

Phase 1 only. Nothing below is implemented. Base `e7db16e3`.

Decision applied: a drop into a plain terminal quotes the paths for the shell dialect captured at
spawn, delivers them as one bracketed paste through the ordered input writer, and is refused only
when a program other than the shell owns the foreground. The per-drop native verification
(`pty_prepare_path_drop`) is deleted.

## 0. Finding that shapes the design

`pty_prepare_path_drop` is not only the drop check. It is also the only way the page learns the
shell dialect, and two other callers use it for that and nothing else:

- `src/app/App.tsx:819` (the breadcrumb `cd`: passes `[cwd]`, uses `prepared.shell` and `prepared.paths[0]`),
- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts:686` (`captureGhosttyCompletionOwner`'s `verify`, used by block path completion).

So the command cannot simply be removed. The dialect capture stays, as a much smaller command:
`pty_shell_dialect(id) -> "posix" | "fish" | "powershell" | "cmd" | null` (section 2). Both callers move to it.

## 1. New drop flow

Unchanged up to the terminal (OSC 72 programs still take the drop first):

1. OS drop: `useTerminalFileDrop` (`terminal/lib/useTerminalFileDrop.ts`) `onDragDropEvent` -> `terminalPathDropTarget.dropPath` (`createTerminalPathDropTarget`). Explorer drags enter through `useExplorerDnd.ts` -> same `dropPath`, carrying the explorer's `source: WorkspaceEnv` capture (kept).
2. `program?.drop(...)` (`dropOnSession` -> `dropOnGhosttySession`): a program registered for drops (Kitty OSC 72) takes it. Unchanged.
3. Otherwise `paste` = `dropPathsIntoSession` (`terminalSessionApi.ts:92`) -> `dropPathsIntoGhosttySession(leafId, paths, source)` (`useGhosttyTerminalSession.ts:540`). Rewritten as follows.
4. Guard as today: no session, no `pty`, `shellExited` or `disposed` -> return `false`.
5. Branch on tab kind, decided synchronously:
   - Block tab at the prompt (`blocks.getMode() === "prompt"`): `capture = blocks.pathInsertion?.()`. If it yields an `insert` function, keep the existing path (step 6a). If it yields null (cursor not at a verified argument boundary), keep today's "Cannot insert dropped paths" toast and stop: pasting would bypass the command bar's boundary rule.
   - Every other terminal (plain tab, or a block tab whose mode is not `prompt`): plain path (step 6b).
6. a. Command-bar path (same ordering as today): `session.writer.reserveInput()`; `shellDialect(session)` (step 7); `planShellDrop(...)` (step 8); `finish(() => active() && insert(text) ...)`. Only the source of the dialect changes (no `prepareShellPathDrop`, no native verification: the command bar is only active after OSC 133 confirmed the prompt).
   b. Plain path:
    1. `captureGhosttyInputOwner(leafId)` and `session.input` captured (as `pasteIntoGhosttySession` does).
    2. `const finish = session.writer.reserveInput()` synchronously. This fixes the drop's place in the input order before any await, so it sits behind an earlier pending clipboard read or paste confirmation and ahead of later keys (batch C ordering). Null (writer failed or 256 actions waiting) -> return `true`, as today.
    3. `leafShellAtPrompt(leafId)` (`terminalSessionApi.ts:254`: `useTerminalStatusStore.running`, then `pty_has_foreground_job`). `false` -> `finish(() => toast "Cannot insert dropped paths": "A program is running in this terminal.")`; `null` -> same toast, "Could not verify the terminal is at its prompt." (the wording `App.tsx:813` already uses for the breadcrumb).
    4. `dialect = await shellDialect(session)` (step 7); `null` -> toast "This shell does not support dropped paths" (an unknown shell such as nu).
    5. `text = planShellDrop(...)` (step 8); a thrown refusal -> toast with its message.
    6. `finish(() => { if (owner.active() && session.input === input && not running) input.paste(text); else cancelled toast }, text.length * 2)`. `input.paste` is `GhosttyInputController.paste` (`ghostty/input/GhosttyInputController.ts:262`); `deliverPaste` -> `pasteText` encodes with `encodeTerminalPaste(text, modes().bracketedPaste)`, so the bytes are `ESC[200~ ... ESC[201~` when the shell enabled mode 2004 and plain text otherwise, and the paste-confirmation rule (`isUnsafePaste`, slot without deadline) applies unchanged. The nested `deferInput` inside the running action returns false while the writer flushes (`insertion !== null`), the same way `pasteIntoGhosttySession` already relies on, so there is no deadlock and no new controller method.
    7. `session.surface?.focus()`.

    The owner re-check inside `finish` plus the status-store `running` read repeat the foreground test at delivery time without another IPC. The IPC check in 3 is the authoritative one; the window between 3 and delivery is a user action, not untrusted content (O-06's own reasoning).
7. `shellDialect(session)`: `session.dialect ??= await invoke("pty_shell_dialect", { id: pty.id })`, cached per session (a new shell after restart is a new `pty`, so the cache is reset per spawn). One IPC per terminal lifetime, none per drop after the first.
8. `planShellDrop(paths, source, target: WorkspaceEnv, dialect, windows)` (pure, `terminal/lib/shellPathDrop.ts`, replaces `prepareShellPathDrop`) does the checks the native `validate_paths`/`prepare` did, minus process verification:
   - 1 to 256 paths, at most 64 KiB total (the `validate_paths` limits); control characters already throw in `quoteShellPath`.
   - Each path absolute (`^/`, `^[A-Za-z]:[\\/]`, or `^\\\\`).
   - Environment: same kind (and for WSL, same distro) -> unchanged. Host source into a WSL terminal -> `pathForWorkspace(path, target)` (`skills/invocation.ts:75`, drive paths become `/mnt/<drive>/...`); a host path it cannot map (UNC, no drive) is refused. WSL source into a host terminal, or another distro -> refused with the existing toast ("Cannot insert dropped paths", description "Paths from another environment cannot be used in this terminal."). `fs_host_path` is not used: it maps WSL to host for asset URLs, the wrong direction here, and a `\\wsl$` UNC path is no use at a cmd.exe or Git Bash prompt. This also drops the native `wslpath` helper, so custom mount roots under `/mnt` keep the plain drive mapping (a narrowing; stated in AGENTS.md).
   - Windows host terminal with the posix dialect (Git Bash): backslashes become `/` (what `prepare` did); gated on the passed `windows` flag, not a global, for testability.
   - Then `formatDroppedPaths(paths, dialect)`.
9. PTY write: the `finish` action calls `input.paste(text)` -> `emitText(..., "paste")` -> the session's `BoundedPtyWriter.enqueue` -> `pty_write`. Input budget rules (P-02) apply: `text.length * 2` is declared to the slot; over-budget is dropped with the existing notice.

## 2. Quoting per dialect, and the retained dialect capture

Quoting reuses `quoteShellPath` / `formatDroppedPaths` / `DropShell` from `terminal/lib/quoteShellPath.ts` unchanged (already pure and dialect-driven; `safePathCompletion` also takes `DropShell`, so nothing there changes):

| Dialect | Rule (existing code) |
|---|---|
| posix | `'...'`, each `'` becomes `'\''` |
| fish | `'...'`, `\` becomes `\\`, `'` becomes `\'` |
| powershell | `'...'`, `'` becomes `''` |
| cmd | `"..."`; a path containing `"`, `%` or `!` is refused ("cannot be safely inserted into cmd.exe") |

Output is the quoted paths joined by one space plus a trailing space (`formatDroppedPaths`). Control characters and empty paths throw.

Native dialect capture, trimmed rather than deleted: `path_drop.rs` is replaced by a small `pty/shell_dialect.rs` holding only `Dialect` (serde lowercase), `dialect(path)` and the canonicalized-argv0 lookup from `Shell::from_command` (the alias test is kept; the macOS `/bin/sh` launcher mapping and the `executable` field go, since nothing compares executables any more). `Session` keeps `dialect: Option<Dialect>` instead of `drop_shell` and loses `drop_pending` and `accepts_path_drop`. New command `pty_shell_dialect(webview, state, id)` in `pty/mod.rs`: owner-checked like `pty_prepare_path_drop` was (`session.owner == webview.label()`), returns `Option<Dialect>`, no blocking work, no verification.

WSL: today the dialect comes from `OARLOCK_DROP_SHELL`/token env vars and an `sh -c` wrapper that exist only for per-drop verification. The wrapper and the four variables `OARLOCK_DROP_OWNER`, `OARLOCK_DROP_DISTRO`, `OARLOCK_DROP_TOKEN`, `OARLOCK_DROP_SHELL` in `shell_init.rs:1030-1047` are deleted (the wsl.exe command goes back to the plain exec form). The WSL command builder returns the dialect it already knows (`dialect(&shell_path)`, the basename of the chosen shell) alongside the command; `session.rs:329` takes that instead of re-deriving it from the `CommandBuilder`. This is Windows-only code that cannot run here; it gets a unit test on the pure part and is flagged for Windows CI.

## 3. Refusal condition (exact)

The drop is refused, with the toast "Cannot insert dropped paths" and a description, when any of:

- `leafShellAtPrompt(leafId) === false`: the terminal status store says a command is running (OSC 133), or `pty_has_foreground_job` says a job owns the terminal (Unix: the foreground process group leader is not the shell; Windows: a console-subsystem child of the shell). A background job (`npm run dev &`) does not count, matching the breadcrumb and `send_to_agent`.
- `leafShellAtPrompt(leafId) === null`: the check failed or there is no shell. Fail closed, as the breadcrumb does.
- the dialect is `null` (unrecognized shell), or `planShellDrop` throws (count or size, relative path, control character, cmd metacharacter, incompatible environment).
- the pane's owner went stale (restart, close, navigation, shell exit) between drop and delivery; this uses the existing "Terminal input cancelled" toast.

It is not refused because the cursor sits inside an open quote or a compound command (the residual risk the review accepts as a user action). Block tabs at the prompt keep the stricter command-bar boundary rule.

## 4. Deleted, with grep evidence

Evidence command: `grep -rIn "path_drop\|pty_prepare_path_drop\|prepareShellPathDrop\|drop_pending\|accepts_path_drop\|drop_shell\|OARLOCK_DROP\|wsl_probe" src src-tauri scripts docs AGENTS.md` (run in this worktree; results summarized).

Rust (`src-tauri/src/modules/pty/`):
- `path_drop.rs` (replaced by the small `shell_dialect.rs`), `path_drop/wsl.rs`, `path_drop/wsl_probe.sh`; `mod path_drop;` (`mod.rs:8`).
- `pty_prepare_path_drop` (`mod.rs:404-430`), its registration `lib.rs:454`, and the test `path_drops_require_the_original_live_foreground_shell` (`mod.rs:643-690`, with the `open_running`/`wait_for` helpers if nothing else uses them; clippy will say).
- `session.rs`: `drop_shell`, `drop_pending`, `accepts_path_drop`, the `Shell::from_command` call at 329 (becomes the dialect field), the initializers at 384-385.
- `shell_init.rs:1030-1047`: wrapper and the four `OARLOCK_DROP_*` variables. Only users: `path_drop.rs` and `path_drop/wsl.rs`; the grep finds no other hit outside `shell_init.rs`.
- Not deleted: `foreground.rs` (`shell_has_children` and `verified_console_children` are used by `pty_has_foreground_job` at `mod.rs:376,399`), `close_output`. The `libc` dependency stays; clippy decides about unused imports.

Frontend:
- `shellPathDrop.ts` rewritten (pure `planShellDrop`), `shellPathDrop.test.ts` and `orderedPathDrop.test.ts` rewritten to the new flow.
- `useGhosttyTerminalSession.ts`: the `invoke("pty_prepare_path_drop")` at 686 and the drop body at 540-598.
- `App.tsx:819`: the breadcrumb `cd` switches to the dialect command plus the same single-path conversion, keeping its prompt check and prefix logic.
- Kept: `useTerminalFileDrop.ts`, `shellDropInsertion.ts` (command-bar boundary, still used by `ShellInput.tsx`), `quoteShellPath.ts`, `programDrop.ts`.

Scripts: `scripts/terminal-shell-drop/probe.py` (the Linux PTY harness for the native verification; referenced only by `AGENTS.md` Review 98, `docs/pr-1-review-coverage.md:331` and `REVIEW_LEDGER.md`). `regex-probe.mjs` and `regex-worker-probe.mjs` in the same folder are NOT drop probes: `scripts/terminal-search/README.md`, `scripts/terminal-search/vite.config.ts` and `scripts/editor-search/vite.config.ts` use them, so they stay and the folder keeps its now misleading name (moving them is out of scope; noted for the merger). Historical review prose (Review 98, coverage doc, ledger) stays as the record.

## 5. Regression tests

Frontend (vitest; real `BoundedPtyWriter` and real `GhosttyInputController` where the existing ordered tests already use them):

1. `shellPathDrop.test.ts`, `planShellDrop`: posix, fish, powershell and cmd each produce the exact quoted string for a path with a space, a `'` and `$(x)`; cmd refuses `%`, `!` and `"`; control characters, an empty list, 257 paths, over 64 KiB and a relative path are refused; Windows posix gets forward slashes; a local source into WSL maps `C:\x` to `/mnt/c/x` and refuses UNC; WSL same distro is unchanged; WSL to host and cross-distro are refused.
2. A plain-terminal drop reaches the PTY as one bracketed paste: drive `dropPathsIntoGhosttySession` on a plain session (real controller, bracketed paste on, mocked `invoke` answering `pty_has_foreground_job: false` and `pty_shell_dialect`), assert exactly one `pty_write` equal to `ESC[200~'/a b' '/c'\'''  ESC[201~`-style per dialect (one case each), and plain text when the program has not enabled mode 2004.
3. A foreground program refuses: `pty_has_foreground_job: true` (and the `running` status and `null` variants) -> nothing written, `toast.error("Cannot insert dropped paths")` with the program-running description, and the writer slot is released (a following key is written).
4. A block tab at the prompt still inserts at the cursor: a session with `blocks.getMode() === "prompt"` and a `pathInsertion` capture; the text goes to `insert` (not `input.paste`), no `pty_has_foreground_job` call; an unsafe boundary (capture null) still toasts.
5. Ordering: a drop queued behind a stalled clipboard read (the `orderedPaste.test.ts` pattern, a held `reserveInput`) is written after that paste and before keys typed after the drop; a drop whose owner goes stale before delivery writes nothing and releases the slot.
6. A registered application drop (OSC 72) still wins: the existing `programDrop.test.ts` and `useTerminalFileDrop.test.ts` pass unchanged.
7. Dialect cache: two drops cause one `pty_shell_dialect` call; a restart (new `pty`) asks again. The breadcrumb `cd` tests keep passing with the mock switched to `pty_shell_dialect`; `completionOwnership.test.ts` is unchanged (its `verify` is injected).

Rust:

8. `shell_dialect.rs`: the two existing dialect tests moved over (basename table; symlink alias does not pick fish), WSL shell-path basename cases, and the `pty_shell_dialect` owner check (another webview label gets "Terminal no longer exists").
9. Deleted with the code: `rejects_control_characters_and_unbounded_drops`, `reads_real_process_executable`, the Review 98 native test.

Gates: `bun run lint`, `bun run check-types`, `bun run test`, clippy, `cargo test --locked -- --test-threads=1`, no U+2014, `source-encoding.test.ts`.

## 6. AGENTS.md sentences to change

1. Terminal migration status, lines 367-369: replace "elsewhere a drop inserts the paths quoted for the pane's own shell (POSIX, fish, PowerShell or cmd literal syntax), only when the command bar has a known argument boundary and the native check confirms the pane's shell (its launched executable and sole foreground process group; a WSL pane's paths are translated with `wslpath`), and is otherwise refused with a visible notice." with: "elsewhere a drop is pasted as the paths quoted for the shell the pane launched (POSIX, fish, PowerShell or cmd literal syntax, `quoteShellPath`), as one bracketed paste in input order, and is refused with a visible notice only when a program other than the shell owns the foreground (`leafShellAtPrompt`), the shell is not a recognized one, or the paths cannot be quoted for it. A block tab at its prompt inserts at the command bar's cursor instead, and only at a known argument boundary. Paths from a host explorer reach a WSL pane as `/mnt/<drive>/...`; paths from another environment are refused."
2. PTY shell integration bullet: add after the `TERM_PROGRAM` sentence: "The shell dialect (`posix`, `fish`, `powershell`, `cmd`) is chosen from the launched executable once at spawn (`pty/shell_dialect.rs`; for WSL from the chosen shell's name) and read by the page through `pty_shell_dialect` for dropped paths, the breadcrumb `cd` and path completion; nothing verifies the process per drop."
3. Review 98 section (line ~4924-4960): append "Review 107 (O-06) reversed the per-drop native verification; see the PTY shell integration bullet." Review 98's own prose stays as history.
4. Review 107 list: add O-06 to the batch G entry when the merger writes it.
5. `docs/architecture/pty-shell-integration.md` and `docs/architecture/two-process-model.md`: replace `pty_prepare_path_drop` with `pty_shell_dialect` if present (grep in phase 2).

## Open points for the owner

- WSL host-path translation is the drive-letter mapping only (no `wslpath`, no custom mount roots). Say if the native `wslpath` call should survive for that one case.
- A WSL source into a host Windows shell is refused rather than translated through `fs_host_path` (UNC paths do not work at cmd.exe or Git Bash prompts).
- A block tab at the prompt with an unsafe boundary is still refused (not pasted raw); the owner's text names plain terminals as the fallback, so this reads as intended.
