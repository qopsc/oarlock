# Batch G: plain-terminal file drops (O-06)

Branch `worktree-agent-a1ad4e2b48e3a1e3b`, based on `review/codex-fixes` at e7db16e3. Design:
`design-G.md` (with the adopted review revisions).

## 1. Finding closed

| ID | Fix | Location | Tests | Commit |
|----|-----|----------|-------|--------|
| O-06 | An OS or explorer file drop into a terminal that is not at the command bar is pasted as the paths quoted for the shell dialect captured at spawn, as one bracketed paste through a reserved input slot. It is refused only when a program other than the shell owns the foreground (`leafShellAtPrompt`: status store `running`, then `pty_has_foreground_job`), the shell is unrecognized, or the paths cannot be quoted or mapped. A block tab at its prompt keeps the command-bar insertion at a verified boundary. The per-drop native process verification is deleted. | `src/modules/terminal/lib/shellPathDrop.ts` (`planShellDrop`, `convertShellPath`, `runShellDrop`), `shellDropLauncher.ts`, `dropOwnership.ts`, `shellDialectCache.ts`, `ghostty/useGhosttyTerminalSession.ts` (`dropPathsIntoGhosttySession`, `shellDialect`), `src-tauri/src/modules/pty/shell_dialect.rs`, `pty_shell_dialect` in `pty/mod.rs` | `shellPathDrop.test.ts`, `orderedPathDrop.test.ts`, `dropOwnership.test.ts`; Rust `shell_dialect` tests and `the_shell_dialect_is_the_launched_shells_and_belongs_to_its_window` | 2e3ce7d3, ae33ac49, 34eec63d, a8e7f683 (rework 1), 074408f9 (rework 2, foregroundJob helper) |

## 2. Behavior

- Dialect: `pty_shell_dialect(id)` (owner-checked with `state.owned`) returns the dialect chosen once at spawn from the canonicalized launched executable (`posix`, `fish`, `powershell`, `cmd`, or null). The page caches it per pty (`cachedShellDialect`): a restart or a shell preference change asks again, and a reply that lands after the pty changed is not stored. The breadcrumb `cd` and block path completion use the same command (completion refuses a null dialect).
- Quoting reuses `quoteShellPath` / `formatDroppedPaths` unchanged. Host paths into a WSL pane map `C:\x` to `/mnt/c/x` (inline mapping, no import of `skills/invocation.ts`); host paths with no drive, WSL paths into a host terminal and paths from another distro are refused. A Windows POSIX shell (Git Bash) gets forward slashes. `fs_host_path` is not used (wrong direction).
- Ordering: the slot is reserved synchronously in the drop event, so a drop queued behind a pending clipboard read or paste confirmation keeps its order and keys typed during its IPC awaits land after it. Every path after the reservation releases the slot exactly once (rejected IPC, thrown check, failed lazy import: `launchShellDrop` and the try/catch in `runShellDrop`).
- Ownership: drops use `captureDropOwner`, not the input owner: input, focus and cwd revisions are ignored, so dropping onto a non-active split pane and typing during the awaits do not cancel the drop. Restart, close, navigation, shell exit, a new input controller and an aborted lifetime do.
- A block tab whose mode turns `prompt` between drop and delivery refuses the delivery (the drop is not routed into the command bar past its boundary rule).
- WSL limitation (owner decision): `pty_has_foreground_job` cannot see Linux processes behind `wsl.exe`, so a WSL pane accepts a drop only when shell integration reported the end of a prompt for the current shell (`session.promptSeen`, set on OSC 133 B, the signal the command bar trusts, not on A or D; reset on restart), `running` is false and the alternate screen is off (`shellPromptConfirmed`), checked at the start and again at delivery; otherwise it is refused with the notice. The same rule sits inside `ghosttyLeafHasForegroundJob`, so the breadcrumb `cd` (and `send_to_agent`, which uses `leafShellAtPrompt`) fail closed in WSL panes without integration, as the old marker probe did.

## 3. Deleted

`pty/path_drop.rs`, `pty/path_drop/wsl.rs`, `pty/path_drop/wsl_probe.sh`, `pty_prepare_path_drop` and its registration, its native test, `Session.drop_shell`, `drop_pending`, `accepts_path_drop`, the WSL launch wrapper and the `OARLOCK_DROP_OWNER`, `_DISTRO`, `_TOKEN`, `_SHELL` variables, `scripts/terminal-shell-drop/probe.py`. `regex-probe.mjs` and `regex-worker-probe.mjs` in that folder stay (used by `scripts/terminal-search` and `scripts/editor-search`).

## 4. Deviations from the design

- WSL dialect: instead of changing the `spawn_with` closure signature, the WSL launch sets `OARLOCK_LAUNCH_SHELL` on the `wsl.exe` command (not in `WSLENV`, so the distro never sees it) and `shell_dialect::from_command` reads it. Nothing outside `pty/*` changed. This is Windows-only code: the Windows branch is unit-tested through `CommandBuilder` on this host but not run on Windows.
- Tests for the session-level glue (`dropPathsIntoGhosttySession` itself) are indirect: its decisions are in `runShellDrop`, `captureDropOwner` and `cachedShellDialect`, each tested; the thin wiring is not.

## 5. AGENTS.md / docs edits (done in this branch)

Terminal migration status drop sentence, PTY shell integration dialect sentence, Review 107 (batch G entry added, O-06 removed from the deferred list), review document O-06 status. `docs/architecture/*` had no mention of the removed command.

## 6. Checks

- `bun run check-types`: `$ tsc --noEmit && tsc --noEmit -p scripts/tsconfig.json` (no errors)
- `bun run lint`: `Found 80 warnings.` (same count as base)
- `bun run test` (real `bun install --frozen-lockfile` in the worktree): `Test Files  649 passed (649)`, `Tests  6238 passed | 2 skipped (6240)`. The first run used a symlinked `node_modules` and showed two vim files failing; that was the symlink.
- Size, measured by the reviewer against a base build of e7db16e3 (before the rework): +1,125 bytes total client JS, +349 primary terminal, +29 startup, WebGL and WASM unchanged. `.size-limit.json` is not changed here.
- `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`: `Finished dev profile ... target(s)` with no warnings.
- `cd src-tauri && cargo test --locked -- --test-threads=1` (nextest is not installed): `test result: ok. 1673 passed; 0 failed; 4 ignored` for the library and `ok` for every integration binary.
- No U+2014 in the diff against the base. `bun run size` was not run in this worktree.
