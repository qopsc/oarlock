# Independent review of PR #2 (`review/codex-fixes` into `claude/amazing-brown-42we46`)

Reviewed: 2026-11-01. Range: `577ccc9..1bc762f`, 134 commits, 1,088 files, 133,140 insertions
and 9,046 deletions (833 source files under `src`, `src-tauri/src`, `packages` and `scripts`).
Reviewer stance: independent; the code was not written by the reviewer. `REVIEW_LEDGER.md` was
read for intent and for the approved threat model only. Its claims were checked against the code
and are scored in the claims table near the end; none was taken on trust.

## How to read this document

- Threat model, as the owner approved it: untrusted repository content and misbehaving
  restricted components (MCP servers, agents, the sandboxed helper, model output) are guaranteed
  boundaries; races with a separate hostile same-user process are best effort and appear only as
  Low. Ordinary concurrency (the user, another window, autosave, a formatter, Git) counts fully.
  Findings whose only actor is script already running in the app's main origin are Medium.
- Platforms: macOS at full severity; Linux findings are tagged `Linux (secondary)` and capped one
  step lower; Windows is omitted unless the code silently does the unsafe thing instead of
  refusing.
- Severity in three vocabularies: `Critical/High/Medium/Low`, the ledger's
  `BLOCKER/MAJOR/MINOR`, and a 0 to 10 score. Critical: boundary bypass or silent data loss
  reachable from untrusted content or ordinary use. High: the same under a common configuration
  or ordinary concurrency, or a guard that blocks ordinary use for many users. Medium: a
  defense-in-depth gap, or a test that does not prove its claim. Low: simplification or clarity.
- Verdicts: CONFIRMED means the full path was traced and, for High and above, reproduced with a
  disposable fixture or verified line by line in the production call path; PLAUSIBLE means the
  path reads as reachable but something named in the entry was not exercised.
- Tags: `security`, `data-loss`, `over-engineering`, `test-quality`, `compat`. A finding the
  ledger already records as open carries `ledger: open as Rnnn`.
- ID prefixes: `S` security fixes, `D` data loss, `P` terminal and PTY, `A` AI and MCP, `O`
  over-engineering and compatibility, `T` test quality. Items from the second-reviewer passes
  were re-read in the production path before ranking; each entry states what was checked.
- Reproductions live under the session scratchpad, listed at the end. No file was added to the
  repository tree during the review and no code was changed.

## Summary

The findings below have been addressed on this branch (the batch notes are in `docs/reviews/pr-2-fixes/`); per-finding status follows each entry, and this summary describes the code as reviewed. The four security fixes hold their core promise on macOS: Git is launched through one guarded
launcher with a fresh per-command preflight, remote URLs are read NUL-framed and refused on
control characters, the forked store plugin opens its files directory-bound without following
links, and the guarded preview scheme authorizes the handle it opened. Each fix has a hole next
to the fixed spot, and the data-loss work has one large gap that no revision machinery covers:

- The guarded preview scheme still serves `text/html` for any workspace file whose extension
  it does not recognize, and a sandboxed preview frame can navigate itself there. A WebKit probe
  ran script on the scheme origin and read a second file through it (S-01).
- An AI write of `.mcp.json` is recorded as the user's own trust decision, so model output can
  start a configured program in every window without the trust prompt (S-15).
- The Git guard refuses user-wide `filter.*`, `gpg.*.program` and `core.fsmonitor`, so every
  Git LFS user and every SSH or GPG signing user loses all of native Source Control (S-02).
- Deleting a space disposes every dirty editor and kills every running terminal in it from one
  hover icon, with no confirmation (D-01).
- The terminal's new fail-stop paths are sticky with no reset: one oversized paste, one reply
  flood from a program, or one query flood in output permanently disables a pane (P-01, P-02).
- Plan-mode Apply writes each queued edit over the disk content it was computed from, so two
  edits to one file in one plan lose the first (D-14).

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 11 |
| Medium | 35 |
| Low | 26 |

## Findings

### High

**S-01** · High · ledger BLOCKER (same untrusted-content boundary as R240) · 8.0 · CONFIRMED ·
`security` · `src-tauri/src/modules/asset_all_folders.rs:251`, `:334-339`, `src-tauri/src/modules/pty/gate.rs:92-94`,
`src/modules/preview/PreviewPane.tsx:159-172`, `src-tauri/tauri.conf.json:31`
Status: fixed in cec8d8a (batch B); test html_bytes_are_never_served_as_a_document_whatever_the_name

The R240 fix sniffs content only when the requested extension is `.pdf`. Every other request is
typed by `MimeType::parse`, whose fallback for an unknown extension is `text/html`
(`tauri-utils-2.10.2/src/mime_type.rs:55-75`), and `infer` recognizes HTML bytes directly. A
workspace file named `notes.md`, `logo.png` or `README` whose bytes are HTML is served as a
document with no `Content-Security-Policy` and no sandbox. The gate accepts requests that carry
no `Origin` header, which is every navigation, image and same-origin fetch. The preview pane's
iframe keeps `allow-scripts allow-same-origin` and the app CSP lists `oarlock-asset:` in
`frame-src`, so a page shown in the preview pane can set `location.href` to an `oarlock-asset:`
URL.

Failure scenario: the user clones an untrusted repository and opens a documentation site it
links to in the preview pane. That page navigates its own frame to
`oarlock-asset://localhost/<encoded path of a repository file containing HTML>`. The file's
script runs on the `oarlock-asset://localhost` origin, fetches any other authorized workspace
file through the same scheme, and posts it to a remote host. With "Allow the app to access all
folders" on, every non-dot path on the machine is readable, including `/etc/passwd` to learn user
names. With the switch off the attacker must know a workspace path.

Reproduction: `webkit-probe/probe.swift` registers `tauri` and `oarlock-asset` scheme handlers
that return the handler's headers and MIME decision, loads the parent page with the app CSP and
the preview iframe attributes, and lets the framed `http://localhost` page navigate to a `.md`
file. `webkit-probe/hits.log` shows the exfiltration request carrying `SECRET-CONTENT-42` from
origin `oarlock-asset://localhost`; `probe.log` shows both scheme requests with `Origin=<none>`.

Fix: serve only an allowlist of types (`image/*`, `video/*`, `audio/*`, `application/pdf`) and
answer everything else as `application/octet-stream` with `nosniff` and
`Content-Security-Policy: sandbox`; drop `oarlock-asset:` from `frame-src` except for the PDF
frame.

---

**S-15** · High · ledger BLOCKER · 8.0 · CONFIRMED · `security` ·
`src-tauri/src/modules/project_trust.rs:777-800`, `src-tauri/src/modules/fs/file.rs:329`, `src-tauri/src/modules/fs/mutate.rs:331`,
`src/modules/mcp/lib/projectServers.ts:103-118`
Status: fixed in 2c28542 (batch E); test
the_ais_own_writes_ask_again_where_the_editors_keep_the_answer

`keeping_trust` is called from `fs_write_file` and `fs_create_file` regardless of the command's
`origin`. When the previous `.mcp.json` held nothing (absent, blank, no servers) the write is
recorded as allowed. Project servers default to enabled. `AGENTS.md` documents this as the
intended behavior for "the AI's approved or auto-approved writes", which is exactly the problem:
under Auto-approve, model output alone can author a server definition and have it started by
`mcp_project_spawn` on the next turn in every window with the project open, with no trust prompt
and no card. The threat model names model output as a restricted component whose data must not
cause execution without the user's consent; the trust prompt is that consent.

Failure scenario: a repository README carries a prompt injection. The agent in Auto-approve
writes `{"mcpServers":{"x":{"command":"curl","args":[...]}}}` into a project that had no
`.mcp.json`. The native write keeps trust; the next agent run starts `curl` with the model's
arguments. Under Ask mode the user approves a `write_file` card showing JSON, which is not the
prompt that explains what a server command does. The test
`oarlock_s_own_edits_keep_the_answer_on_mcp_json` (`project_trust.rs:1744`) locks the behavior.

Fix: skip `keeping_trust` for `Origin::Ai` on the `McpJson` and skills kinds (and arguably
`AGENTS.md`), so the next run shows the trust prompt; keep it for editor saves.

---

**S-02** · High · ledger MAJOR · 7.5 · CONFIRMED · `over-engineering`, `compat` ·
`src-tauri/src/modules/git/commit_guard.rs:50-59`, `:226`
Status: fixed in e284cbf (batch A); test
git_executable_refusal.rs::user_scope_lfs_signing_and_fsmonitor_settings_are_accepted

`executable_setting` refuses `filter.*.clean/smudge/process`, `gpg.program`, `gpg.<format>.program`
and `core.fsmonitor` in every scope, and `inspect_repo_origins` applies the table to user-wide
and system files with `repository_scope = false`. `git lfs install` writes `filter.lfs.*` to the
user's global config; 1Password, GitHub Desktop and GPG users set `gpg.ssh.program` or
`gpg.program` globally; Git's own documentation recommends `core.fsmonitor = true` on macOS.
None of those is a repository-controlled program, and the same table already treats
`credential.helper` as user-trusted outside the repository. Because the preflight runs on every
entry point, those users are refused for status, diff, history and the panel, not only commit.

Reproduction: `lfs-home/.gitconfig` holds the three `filter.lfs.*` lines `git lfs install`
writes. `HOME=<scratchpad>/lfs-home cargo test --test git_entrypoint_guard
authorized_clean_bare_remote_can_push_and_fetch` fails with "native Git refused: a Git filter
driver can run an external program" (`repro-lfs-global.log:824-834`). Production code strips
`GIT_CONFIG_GLOBAL` but reads `$HOME/.gitconfig`, so the environment override does not mask it.
The same mechanism makes the shipped guard suites fail on any developer machine with LFS
installed (O-04).

Fix: gate `filter`, `diff.*`, `merge.*.driver`, `gpg.*`, `core.fsmonitor` and `commit.gpgSign`
on `repository_scope`, as `credential.helper` already is, and keep the `-c core.fsmonitor=false`
and `commit.gpgSign=false` invocation overrides for the rest.

---

**D-01** · High · ledger MAJOR · 7.5 · CONFIRMED · `data-loss` · `src/app/App.tsx:1541-1551`,
`src/modules/tabs/lib/useTabs.ts:955-974`, `:579-606`, `src/modules/spaces/SpaceSwitcher.tsx:335`, `:527-533`, `src/modules/spaces/lib/useSpaces.ts:103-110`
Status: fixed in 1f96a5a (batch D); test useTabCloseGuards.revisions.test.ts "deleting a space with
a dirty editor asks before it commits"

`handleDeleteSpace` calls `useSpaces.remove`, which deletes the persisted space state, then
`removeTabsForSpace`, which plans the removal of every tab in the space and disposes every
terminal leaf. Nothing on that path asks `editorIsDirty`, checks a foreground process or consults
the close revisions that AP013 added for Close Others and Close Right. The trash icon in the
space row calls `onDeleteSpace` directly and the row reveals it on hover beside Rename.

Failure scenario: a user hovers a space row to rename it and clicks the trash icon. Every
unsaved editor in that space is disposed and every shell, including one running a build or an
agent, is killed. Detached-draft recovery does not apply because the sessions are disposed, not
detached, and the persisted state is already gone.

Fix: route space deletion through `handleCloseMany` with the space's tab ids so dirty buffers and
running terminals prompt, and call `remove` only after the user confirms.

---

**D-14** · High · ledger MAJOR · 7.5 · CONFIRMED · `data-loss` · ledger: open as R169 ·
`src/modules/ai/store/planStore.ts:66-98`, `src/modules/ai/tools/edit.ts:84-102`, `src-tauri/src/modules/fs/file.rs:304-345`
Status: fixed in 2738438 (batch E); test planStore.test.ts "same-file edits and stale versions"

In plan mode `edit` computes `proposedContent` from the file as it is on disk at the time of the
call and enqueues it. `applyAll` later writes each queued `proposedContent` through
`client.writeFile`, which is `fs_write_file`, a write with no expected version. Two queued edits
to the same file are both derived from the original disk content, so the second write replaces
the first; both results report `ok`. A user who saves the file in the editor while the plan diff
is open is overwritten the same way.

Failure scenario: the model edits `foo.ts` twice in one plan (regions X then Y). Apply writes
`v1+X`, then `v1+Y`. X is gone and nothing says so. The non-plan `edit` path re-reads immediately
before writing, so its window is milliseconds and is reported as Low under D-09.

Fix: apply through `fs_save_document` with the version captured at enqueue and refuse on
mismatch; apply same-file edits onto the running candidate instead of the original.

---

**P-01** · High · ledger MAJOR · 7.5 · CONFIRMED · `data-loss`, `security` ·
`packages/ghostty-core/adapted/wasm/src/oarlock.zig:993-997`, `:2437`, `:2792`, `packages/ghostty-core/lib/adapted/OarlockGhostty.ts:782-784`,
`src/modules/terminal/lib/PtyOutputReceiver.ts:146-170`
Status: fixed in 98dadfb (batch C); test AdaptedGhosttyProtocols.test.ts "drops the reply that does
not fit, keeps whole replies and survives"

Commit `8c91d28` replaced truncation of the reply queue with a `reply_overflow` flag. The flag
is set when a parse slice's replies would exceed 256 KiB and is never cleared: the only writer
is the setter, and neither RIS nor a terminal reset touches it. Once set, `restty_write` returns
error 5 and `restty_output_len` returns `i32::MAX` for every later call, the host throws, and
`PtyOutputReceiver.fail` ends the pane with "Terminal reply buffer overflow". Replies are
cumulative per 32 KiB slice and the host drains only after the slice, so the limit is reachable
from output: the terminal reviewer measured XTGETTCAP `sgr` answering 204 bytes for 7 input
bytes from the shipped WASM, so roughly 9 KB of DCS `+q` requests inside one slice overflows.

Failure scenario: `cat` of a crafted file, or any program that emits a burst of terminal queries,
kills the user's shell pane and whatever was running in it. The pre-PR code dropped the excess
and kept the pane.

Fix: drop the offending reply and clear the flag at the end of `restty_write` or on
`restty_output_consume`; never keep a fatal flag that nothing resets.

---

**P-02** · High · ledger MAJOR · 7.0 · CONFIRMED · `data-loss` ·
`src/modules/terminal/lib/BoundedPtyWriter.ts:120-131`, `:146-151`, `src/modules/terminal/ghostty/input/GhosttyInputController.ts:313-333`, `:855-885`,
`src-tauri/src/modules/pty/session.rs` (writer thread, unbounded `write_all`)
Status: fixed in 6eb3ea9 (batch C); test BoundedPtyWriter.test.ts "refuses input past its budget"

`enqueue` now calls `this.fail()` when the pending bytes would exceed 256 KiB; `failed` is sticky
until `detach` (shell exit or respawn) and raises the persistent "Terminal input stopped.
Restart this terminal" toast. The pre-PR `enqueue` returned `false` and left typing alive
(`git show 577ccc9:src/modules/terminal/lib/BoundedPtyWriter.ts:52-66`). Two ordinary triggers:

- A paste is one `enqueue` call with no chunking, so Cmd+V of more than 256 KiB (a log pasted
  into Claude Code, a JSON blob into `cat > f`) permanently disables input for that pane.
- Replies share the same `fail`. A program that prints a few thousand `ESC [ c` queries and then
  stops reading stdin makes the native writer block in `write_all` once the slave input queue
  fills; the in-flight write never resolves, reply bytes pass 256 KiB, and every later keystroke
  including Ctrl+C is refused until Restart. This one is reachable from untrusted output.

Fix: refuse or chunk the oversized paste with a toast, return `false` for refused replies, and
reserve `fail()` for real `pty_write` errors.

---

**D-02** · High · ledger MAJOR · 7.0 · CONFIRMED · `data-loss`, `compat` ·
`src-tauri/src/modules/asset_all_folders.rs:36-37`, `:58-66`, `src/modules/markdown/MarkdownImage.tsx:88-107`,
`src/modules/workspace/assetUrl.ts:12-19`
Status: fixed in 61bc191 (batch B); test a_request_beyond_the_admission_slots_waits_for_one

All workspace image, media and PDF previews now load through the guarded scheme. The handler
admits at most 64 pending requests with `try_acquire_owned` and answers the rest with 503 and no
`Retry-After`. `MarkdownImage` records a failed URL in `failedLocalUrl` and renders the "too
large or could not be loaded" state for as long as the URL is unchanged. WebKit does not
serialize custom-scheme image loads: a probe page with 150 `<img>` tags produced 150 concurrent
scheme tasks (`webkit-probe/probe2.swift`).

Failure scenario: open a README or a chat reply with more than 64 local images. The first 64
load; every later image is refused and stays broken, and no scroll, resize or wait retries it.

Fix: queue admissions with a bounded wait behind the 64 cap instead of refusing, and treat 503
as retryable in `MarkdownImage` rather than latching it.

---

**D-15** · High · ledger MAJOR · 7.0 · PLAUSIBLE (traced, not run) · `compat` ·
`src/modules/editor/GitDiffPane.tsx:203`, `:219`, `src/modules/editor/lib/watchWorkingDiff.ts:59-78`, `src-tauri/src/modules/fs/watch.rs:725-733`
Status: fixed in 96bb200 (batch D); test a_file_deleted_with_its_folder_is_reported_not_fatal

The working-diff pane starts its reader only after `watch.ready` resolves, and `ready` calls
`fs_watch_add` with the file's parent directory in `paths` and the file in `files`. Native
refuses a file whose parent cannot be canonicalized ("Cannot watch ...: parent directory
unavailable"). A file deleted together with its folder therefore never shows a diff: the pane
shows the watch error with a Retry that fails the same way.

Failure scenario: `git rm -r src/old` or deleting a folder in Finder, then clicking one of its
files in Source Control to review what is being removed.

Fix: for a deleted entry watch only the repository root, treat a missing parent as non-fatal,
and load the diff before the watch settles.

---

**D-16** · High · ledger MAJOR · 7.0 · PLAUSIBLE (traced, not run) · `compat` ·
`src-tauri/src/modules/windows/restore.rs:38-44`, `:476-490`, `src-tauri/src/lib.rs:386-389`
Status: fixed in 3787319 (batch D); test a_symlinked_data_directory_starts_and_adopts

`windows::restore` runs on every launch, not only when a journal or adoption exists, and `run`
begins with `pin_root`, which opens the app-data directory with `O_DIRECTORY | O_NOFOLLOW`. A
symbolic link at `~/Library/Application Support/<bundle>` (people do this to keep app state on a
synced or larger volume) answers `ELOOP`, `restore` returns an error, `setup` propagates it and
the app exits before creating a window, with the message only in the log.

Fix: resolve the data directory once with `canonicalize` before pinning, and pin only when there
is recovery work to do.

---

**D-22** · High · ledger MAJOR · 7.0 · CONFIRMED (traced; restore path not run) · `compat`, `data-loss` ·
`src-tauri/src/modules/fs/watch.rs:500-507`, `:720-733`, `src/modules/explorer/lib/watch.ts:98-140`,
`src/modules/editor/useEditorFileSync.ts:112-124`, `src/modules/editor/lib/fileWatchTargets.ts:17`
Status: fixed in 612a69c (batch D); test
failed_watch_preparation_names_the_directories_it_could_not_watch

`prepare_dirs` now returns an error for any directory it cannot canonicalize, and `fs_watch_add`
fails the whole batch. The editor file-sync client adds every open editor and Markdown tab's folder
and file in one batch per workspace scope, and the frontend treats the batch as all-or-nothing:
on failure it shows "Folder live updates unavailable" with infinite duration, and Retry replays the
identical batch. Nothing prunes restored tabs whose folder no longer exists. The pre-PR code
swallowed the error (`git show 577ccc9:src/modules/explorer/lib/watch.ts:26`) and native omitted
the missing directory.

Failure scenario: the user had `src/old/x.rs` open, deleted or switched away from `src/old`, and
relaunches. The tab is restored as missing, its folder joins the batch, the batch fails, no editor
in the window receives a watch handle (no external-change reloads, no Git gutter refresh), and the
toast never expires until the user works out which tab to close.

Fix: return per-path results from `fs_watch_add` (register the valid paths, name the failed ones),
or split the frontend batch per path on failure and notify only for paths that still exist.

### Medium

**S-03** · Medium · ledger MAJOR · 5.5 · CONFIRMED · `security` · ledger: open as R216 ·
`src-tauri/src/modules/store_scope.rs:111-126`, `src-tauri/src/modules/fs/native_store.rs:64-70`
Status: fixed in 8f97b01 (batch B); test every_native_owned_file_is_refused_unless_the_page_opens_it

The store wrapper refuses six file names; the native inventory used by the workspace write guard
lists fifteen. `project-trust.json`, `skills-state.json`, `oarlock-windows.json`,
`oarlock-subagents.json` and `oarlock-ai-sessions.before-message-files.json` are plain names, so a
page may `load`, `set` and `save` them. The trust file holds the per-project allow decisions; the
skills file holds which skills are enabled. Only script in the app origin can issue those calls,
which the ledger treats as unestablished (R239), hence Medium.

Fix: export the list from `native_store.rs` and build the wrapper's refusal from it; add a test
that the two cannot diverge (T-02).

---

**S-04** · Medium · ledger MAJOR · 5.0 · CONFIRMED · `security` ·
`src-tauri/vendor/tauri-plugin-store/src/lib.rs:148-175`, `src-tauri/src/modules/ai_subagents.rs:1`, `src-tauri/src/modules/ai_metadata.rs:107`
Status: fixed in 7536024 (batch B); test grant_tests::a_webview_reaches_only_the_stores_it_opened

Every rid command resolves `app.resources_table().get::<Store>(rid)` without checking which
webview opened the store. Stores the backend opens receive small sequential ids, so a page can
`set` and `save` them by guessing the id without passing the name filter in `load`, which bypasses
the "only the owning page may update" rule the subagent store documents.

Fix: wrap the plugin's rid commands so a page may only use rids it obtained through `load`, or
move backend-only stores off the plugin.

---

**S-05** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `security` · `src-tauri/src/modules/asset_all_folders.rs:235-244`,
`:273-283`
Status: fixed in 3afb85e (batch B); test a_path_outside_every_scope_is_refused_without_being_opened Follow-up 297fe1ab (batch B): links are walked by name and refused before any open.

The handler opens the requested path first and authorizes the opened handle afterwards. The open
follows symlinks and happens for any absolute path, so a request from a frame makes the process
open an arbitrary path before it is refused: an automounted `/net` host, a device node, or on a
later Windows port a UNC share that triggers authentication. The ordering is right against TOCTOU
on the authorized file; it is wrong for the side effects of the open itself.

Fix: apply the asset scope and dot rule to the requested path before opening, then re-check the
opened handle as now.

---

**S-06** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `security` · `src-tauri/src/modules/pty/gate.rs:92-94`,
`src-tauri/src/modules/asset_all_folders.rs:71-82`
Status: fixed in 493c253 (batch B); test only_the_current_page_of_the_window_may_ask

`AllowedOrigins::check` returns the app origin for any request without an `Origin` header. The
comment justifies this for the PTY scheme, where the token is the credential. The preview scheme
reuses the gate with no token, so the only check left is handle authorization. Navigations, image
loads and same-origin fetches send no `Origin`, which S-01 relies on.

Fix: for the preview scheme require `Sec-Fetch-Site: same-origin` from the main origin or a
per-page token in the URL, as the PTY scheme has.

---

**S-07** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `security` · `src-tauri/src/modules/git/operations.rs:213`,
`src-tauri/src/modules/git/worktree.rs:503`, `src-tauri/src/modules/git/branches.rs:250`, `src-tauri/src/modules/git/commit_guard.rs:318-352`
Status: fixed in 70dc926 (batch A); test
process.rs::submodule_recursion_is_off_for_every_guarded_command

The preflight inspects the superproject's config and hooks only. `status` passes
`--ignore-submodules=none`, and `switch`, `pull`, `fetch`, `push` and `worktree add` recurse into
submodules when `submodule.recurse` or the fetch and push recurse settings are on. The `-c`
overrides reach submodule processes through `GIT_CONFIG_PARAMETERS`, but there is no override for
`filter.*`, `diff.*.textconv` or `merge.*.driver`, and a submodule's own `config` and `hooks` are
never read. A clone cannot seed a submodule's config, so this is defense in depth.

Fix: pass `-c submodule.recurse=false -c fetch.recurseSubmodules=false -c
push.recurseSubmodules=false` and `--ignore-submodules=all`, or preflight each initialized
submodule.

---

**S-16** · Medium · ledger MAJOR · 5.0 · CONFIRMED · `security` · `src-tauri/src/modules/fs/file.rs:304-345`,
`src/modules/ai/lib/security.ts`, `src/modules/ai/tools/fs.ts`, `src/modules/ai/tools/edit.ts`
Status: fixed in d432776 (batch E); test ai_gates_refuse_secret_paths_natively_and_app_gates_do_not

`AGENTS.md` says the secret-path deny-list "applies on both read and write and is never
bypassed". Natively, `fs_write_file` and `fs_create_dir` with `origin: "ai"` consult no deny-list;
the guard is `checkReadableCanonical`/`checkWritableCanonical` in the page, called by each tool.
Native `fs_read_file` checks `secret_paths::readable` only to derive the autocomplete eligibility
flag. A page bug or a new tool that forgets the call writes `.env`.

Fix: refuse natively when `origin == Ai` and `!secret_paths::readable` on the requested, real
and opened path for read, write, create and canonicalize.

---

**S-17** · Medium · ledger MAJOR · 5.0 · CONFIRMED · `security` · `src/modules/ai/tools/tools.ts:103-105`,
`src/modules/ai/tools/shell.ts:218-232`, `src-tauri/src/modules/shell/mod.rs:532-543`
Status: fixed in 9187280 (batch E); test a_job_is_reachable_only_from_the_chat_that_started_it

`bash_kill` and `bash_logs` are gated `none` and the job registry is process-wide, keyed by small
sequential handles with no chat or window ownership. A model in chat B can stop or read chat A's
or another window's background job without approval.

Fix: carry the chat id on kill and logs and refuse foreign handles, or gate `bash_kill` as
approvable.

---

**S-18** · Medium · ledger MAJOR · 5.0 · CONFIRMED · `security` · `src-tauri/src/modules/mcp/project.rs:283-300`,
`src-tauri/src/modules/mcp/mod.rs:258-286`, `src-tauri/src/modules/mcp/stdio.rs:244-249`
Status: fixed in f30f72f (batch E); test a_project_server_cannot_set_a_variable_that_loads_code

A project `.mcp.json` entry's `env` map is applied verbatim to the server process but never shown
in the trust prompt, which lists the command line, URL and `${VAR}` names only. A benign-looking
`npx -y @well-known/server` with `"env": {"NODE_OPTIONS": "--require ./x.js"}` (or
`DYLD_INSERT_LIBRARIES`, `PATH`) runs attacker code after the user approves what they saw.

Fix: show env names and values in `describe`; refuse loader variables (`DYLD_*`, `LD_*`,
`NODE_OPTIONS`, `PYTHON*`, `PATH`, `PERL5OPT`, `RUBYOPT`) for project servers.

---

**S-19** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `security` · `src-tauri/src/modules/fs/attachment.rs:180-205`,
`:207-230`
Status: fixed in 8a11211 (batch E); test only_a_path_the_picker_issued_can_authorize_and_only_once

`ai_import_attachment` takes `picked: true` from the page and, when set, calls
`registry.authorize_opened` on any absolute path before the `Origin::Ai` gate. The picker command
returns plain strings with no binding to the import call, so the flag is a page assertion that
authorizes a folder for later AI reads. The deny-list still applies.

Fix: have the picker command import and return attachments itself, or issue one-shot native
tokens per picked path.

---

**S-20** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `security` · `src-tauri/src/modules/project_trust.rs:203-216`,
`:1255-1315`, `src-tauri/src/modules/skills/mod.rs:614-640`, `:670-737`, `src-tauri/src/modules/mcp/project.rs:441-460`
Status: fixed in 3a62735 (batch E); test a_root_the_registry_does_not_authorize_is_not_a_project

`project_trust_status`, `project_trust_decide`, `skills_list/load/read_file` and
`mcp_project_servers` take a page-supplied root with no workspace-registry gate, unlike
`mcp_run_open` and `project_memory_read`. Any readable folder becomes the window's open project
and its `AGENTS.md` head, `.mcp.json` command lines and skill descriptions are returned. The model
cannot pick the root, so this is page-side defense in depth.

Fix: `authorized_existing(&project.real)` in the `resolve_project` callers.

---

**S-21** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `security` · `src/modules/ai/lib/agent.ts:62`,
`src/modules/ai/lib/endpointModels.ts:6`, `src-tauri/src/modules/net.rs:282`, `:98-114`, `src-tauri/src/modules/mcp/mod.rs:729`
Status: fixed in 0a11e55 (batch E); test a_host_keeps_the_class_it_first_had

Custom endpoint calls and model browsing pass `allowPrivateNetwork: true` from the page and the
proxy honors it, whereas MCP derives `allow_private` natively from the configured host. A public
hostname that answers with a private address after the client's 90 s TTL receives the next POST
with the `Authorization` header on a LAN host. Pinning is intact, so not Critical.

Fix: compute `allow_private` natively from the configured host for AI endpoints and `lm_ping`.

---

**D-03** · Medium · ledger MAJOR · 5.0 · PLAUSIBLE (not reproduced with a power cut) · `data-loss` ·
`src-tauri/src/modules/fs/destination.rs:163-185`, `src-tauri/src/modules/fs/private_staging.rs:318-331`
Status: fixed in d1de502 (batch D); test
the_folder_is_synced_after_the_rename_and_a_failed_sync_does_not_fail_the_save

The document save path fsyncs the candidate's content, renames it over the destination, and
returns. The parent directory is never synced, and on macOS `fsync` does not reach the platter
without `F_FULLFSYNC`. The index publisher beside it does sync the directory
(`index_publication.rs:195,232,257`), and the conversation store uses `F_FULLFSYNC`. An editor
save reads as committed while the rename can still be lost on power failure.

Fix: `fsync` the destination directory after the rename (with `F_FULLFSYNC` on Apple) before
returning the new version.

---

**D-04** · Medium · ledger MAJOR · 4.5 · PLAUSIBLE · `data-loss` · `src-tauri/src/modules/fs/document_save.rs:309`,
`src-tauri/src/modules/preferences.rs:413-421`, `src/settings/sections/importPublication.ts:110-118`, `:136`
Status: fixed in ef7333f (batch D); test
a_committed_write_whose_version_cannot_be_read_is_still_a_success

`write_checked` computes the returned version from the published handle after the rename; that
`fstat` can fail after the commit point, so a committed write surfaces as an error. The preference
store wraps any error from a background mutation as `BACKGROUND_NOT_COMMITTED`, and
`importBackground` treats that prefix as proof the update did not commit and deletes the
candidate image. The preference then names an image that no longer exists, and nothing clears a
dangling `backgroundImageId`.

Fix: distinguish "committed, version unavailable" from "not committed" in `write_checked` and in
the wrapping; never delete a candidate on an ambiguous outcome.

---

**D-05** · Medium · ledger MAJOR · 5.5 · CONFIRMED · `data-loss` · `src-tauri/src/modules/fs/reconcile.rs:85-101`,
`:114-136`, `src/modules/editor/lib/documentMutations.ts:135-142`, `src/modules/editor/lib/recoveryTarget.ts:12-15`, `:34-37`, `src/app/App.tsx:931-938`
Status: fixed in 2f475e1 (batch D); test ignored_folders_and_git_internals_are_not_walked

When a versioned open document no longer resolves at its path, reconciliation walks every
workspace root with ignore files disabled and hidden files included, under one shared limit of
100,000 entries or 5 seconds, and fails the whole reconcile on any walker error. A workspace with
`node_modules` or a large `.git/objects`, or a space rooted at the home folder, exceeds the limit
on the first missed rename. The queue then marks itself stalled, every later mutation event
waits, `recoveryMutationCoverage(false)` makes Restore and Save As throw, and Retry runs the same
walk. Documents without a native version (cold tabs, Markdown tabs, editors still loading) are
bound to whatever file now sits at the old path or at `alternate_path` with no identity check.
The trigger needs a sequence gap or an `apply` throw; once triggered the failure is
deterministic.

Fix: respect `.gitignore`, skip `.git`, give each root its own budget, start from the document's
former directory, degrade an unresolved document to `path: null` instead of failing the batch,
and require identity for every binding.

---

**D-06** · Medium · ledger MAJOR · 4.5 · CONFIRMED (occurrence needs rename timing) · `data-loss` ·
`src/modules/editor/lib/documentSession.ts:122-135`, `:445-477`, `:741-749`
Status: fixed in db303b4 (batch D); test documentSession.test.ts "a rename during a coordinated
discard still reads the discarded baseline"

`retarget` calls `release(from)`, which sets `pendingDiscards = undefined`, and bumps `epoch`.
The discard coordinator's later `complete()` sees a changed epoch and returns without the forced
re-read. A rename of the file or its folder while a coordinated discard is running leaves the
editor showing pre-discard text marked clean while disk holds HEAD, and `hasUnsavedChanges()` no
longer reports the "autosaved but Git running" state, so close guards pass.

Fix: carry `pendingDiscards` across `retarget` and key the completion check on
`sessionIdentity`, not `epoch`.

---

**D-08** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `data-loss` · `src/app/App.tsx:1124-1130`, `:1478-1482`,
`src/modules/tabs/lib/useTabs.ts:1682-1753`
Status: fixed in 71780e3 (batch D); test useTabCloseGuards.revisions.test.ts "closing a split pane
asks first when a program runs in it"

`handleCloseTabOrPane` closes the active pane of a split terminal through `closeActivePane`,
skipping the `confirmRunningTerminal` check that `handleClose` applies to a single-pane tab. Cmd+W
kills a running program in a split without a prompt while the same key prompts in an unsplit tab.

Fix: run `leafHasForegroundProcess` for the target leaf before `closeActivePane` and
`closePaneByLeaf`.

---

**D-09** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `data-loss` · ledger: open as R169 ·
`src-tauri/src/modules/fs/file.rs:304-345`, `src/modules/ai/lib/native.ts:233`
Status: fixed in 2738438 (batch E); test fs.test.ts (write_file cases)

`fs_write_file`, the AI `write_file` and non-plan `edit` path, takes no expected version. It
validates origin, the native-store guard and that the destination entry did not move, then
replaces whatever is on disk. The non-plan `edit` re-reads just before writing, so its window is
small; `write_file` has no read at all. The editor notices only if the file is open and dirty.

Fix: send the version from the AI read cache and route through `fs_save_document`.

---

**D-17** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `data-loss` · `src-tauri/src/modules/fs/mutation_events.rs:89-121`,
`:139-151`, `:177-193`, `:307-311`, `src-tauri/src/modules/fs/mutate.rs:495-560`
Status: fixed in 4887ffe (batch A); test
mutation_events.rs::a_running_mutation_does_not_hold_the_stream_lock

`apply_tracked` holds the process-wide stream mutex across the filesystem mutation and the
publish, `fs_delete` and `fs_delete_batch` run `remove_dir_all` inside it, and recovery `begin`
and `changed` take the same lock. Deleting `node_modules` in one window stalls every rename, move
and Save As in every window until it finishes. An `emit` failure is only logged while the
sequence still advances, which is the ordinary source of the gap that triggers D-05.

Fix: hold the lock only to allocate the sequence and to publish after the mutation; order with a
ticket.

---

**D-18** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `data-loss` · `src/app/App.tsx:901-909`,
`src/app/hooks/useTabCloseGuards.ts:229-251`, `src/app/components/CloseDialogs.tsx:275-304`
Status: fixed in 1b3c5c2 (batch D); test useTabCloseGuards.revisions.test.ts "a deleted dirty draft
the same event detached raises no delete dialog"

After a native delete the mutation handler detaches a dirty draft (banner: Restore file, Save
As), and `handlePathsDeleted` then sees it dirty and opens "The file has been deleted. Close
anyway?" whose primary action disposes the tab with no further check. Two contradictory
affordances for the same draft, and the destructive one is the default button.

Fix: do not raise the delete dialog for tabs the same event just detached.

---

**D-19** · Medium · ledger MAJOR · 4.0 · CONFIRMED (not load-tested) · `data-loss`, `compat` ·
`src-tauri/src/modules/net/image.rs:24`, `src/modules/markdown/MarkdownImage.tsx:40`, `src/modules/markdown/remoteImages.ts:39`
Status: fixed in d3bfcbc (batch B); test
a_window_gets_sixteen_images_at_once_and_a_place_frees_when_one_ends

A README with N distinct `https://` images starts N concurrent native fetches, each buffering up
to 16 MiB for up to 20 s; the native admission is `start_bounded(.., usize::MAX)` and the page
caps only completed idle blobs.

Fix: a per-window cap of 16 with page-side queueing.

---

**D-23** · Medium · ledger MAJOR · 4.5 · CONFIRMED (traced, not load-tested) · `compat` ·
`src-tauri/src/modules/net/dns.rs:33-39`, `src-tauri/src/modules/net.rs:50-55`, `src-tauri/src/modules/net/image.rs:22-24`, `:143-146`,
`src/modules/markdown/remoteImages.ts:49-52`, `src/modules/markdown/MarkdownImage.tsx:56-59`
Status: fixed in 8a525e8 (batch B); test fifty_lookups_of_one_host_make_one_resolver_call

The DNS gate admits 8 active lookups and 32 queued callers and answers the 41st with an immediate
"resolver is busy" error. There is no DNS cache, every image fetch resolves its host, image
admission is unbounded, and every mounted remote image starts at once. A README with 50 badge
images from one host mounts 50 fetches in one commit; ten fail instantly and the component latches
the failure until the tab is hidden and shown again.

Fix: single-flight concurrent lookups per host with a short positive cache, or bound the image
loader's own concurrency and queue instead of letting the gate refuse.

---

**O-11** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `compat` · `src-tauri/src/modules/fs/formatter/rustfmt_edition.rs:52`, `:66-90`,
`src-tauri/src/modules/fs/formatter.rs:324-326`
Status: fixed in 0bd3ff6 (batch D); test
an_unreachable_workspace_or_unreadable_manifest_falls_back_to_the_default_edition

The rustfmt edition lookup walks ancestors only while `gates.reaches` and otherwise errors "Cannot
find an authorized Cargo workspace"; an unparsable or oversized ancestor manifest errors too. A
user who opens one crate of a workspace (`~/work/mono/crates/api`, `edition.workspace = true`) now
gets a formatter error on every save where the pre-PR code passed `--edition 2021` and formatted.
The edition is also patched into the argument vector by index (`args[4]`), so a reordering panics
the blocking worker.

Fix: fall back to the previous default edition with a non-blocking notice when the workspace root
is unreachable or a manifest cannot be read; build the argument vector with the edition in
`arguments()`.

---

**S-12** · Medium · ledger MAJOR · 4.5 · CONFIRMED (crash not reproduced) · `security`, `data-loss` ·
`src-tauri/vendor/tauri-plugin-store/src/secure_file.rs:63-68`, `src-tauri/vendor/tauri-plugin-store/src/store.rs:316-318`,
`src-tauri/vendor/tauri-plugin-window-state/src/secure_file.rs`, `src/modules/spaces/lib/store.ts:29`, `src/modules/spaces/lib/useSpacesBoot.ts:220`
Status: fixed in 97f1b98 (batch B); test a_save_replaces_the_file_whole_and_leaves_no_staging_file

The plugin fork's save opens the existing store `O_WRONLY`, truncates with `set_len(0)` and writes,
with no staging, no fsync, no rename and no lock shared with the native writers. The spaces store
autosaves every 500 ms through this path. A crash or power loss inside that window leaves
`oarlock-spaces.json` empty or partial; the next launch logs "spaces boot failed" and the window
comes up with no restored spaces or tabs. The rest of the PR moved every other store to the
conditional atomic writer; the fork added alias checks but not atomicity, and the same file is
duplicated byte for byte in the window-state fork.

Fix: stage through `destination.rs` and rename, or move spaces and window state to a native
revisioned store like preferences; keep one shared `secure_file` module.

---

**A-01** · Medium · ledger MAJOR · 4.0 · CONFIRMED (narrow) · `compat` · `src/modules/ai/tools/agent.ts:74-90`,
`src/modules/terminal/lib/inputOwnership.ts:17-35`, `src/modules/terminal/ghostty/input/GhosttyInputController.ts:362`
Status: fixed in 237b321 (batch C); test agent.test.ts "submits after the delay"

`send_to_agent` writes the instruction, then `"\r"` 90 ms later under the same owner. `active()`
requires unchanged `inputRevision` (bumped by every keydown in that terminal, bare modifiers
included), `focusRevision` (bumped when the pane's visibility flips) and `cwdRevision`. Any of
these in the window cancels only the Enter: the prompt sits typed but unsubmitted while the tool
returns `ok: true`. Separately, the record is removed only on OSC 133;D or PTY close, so in a
shell without integration an exited agent's shell receives the model-authored line plus Enter.

Fix: write `instruction + "\r"` as one owned write and refuse when no armed agent record is live.

---

**P-03** · Medium · ledger MAJOR · 4.5 · PLAUSIBLE (stall frequency unmeasured) · `data-loss` ·
`src/modules/terminal/lib/BoundedPtyWriter.ts:81-111`, `:160`, `src/modules/terminal/ghostty/input/GhosttyInputController.ts:389-428`, `src-tauri/src/modules/clipboard_read.rs:9`
Status: fixed in 6eb3ea9 (batch C); test BoundedPtyWriter.test.ts "drops a reserved slot past the
action cap"

A reserved slot at the head of the input queue blocks all later input until `finish`, with no
deadline on the slot itself. The Cmd+V snapshot slot is held for the native clipboard read (15 s
capture timeout plus up to 30 s page wait). Every keydown and keyup typed meanwhile becomes a
reserved action, so a held key during a stalled read reaches `MAX_PENDING_ACTIONS = 256` in a
few seconds and trips `fail()`, which is sticky (P-02).

Fix: coalesce deferred key repeats, drop rather than `fail()` when the action cap is hit, and put
a deadline on reserved slots.

---

**O-01** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `over-engineering` · `src-tauri/src/modules/git/candidate_index.rs`,
`index_publication.rs`, `candidate_object.rs`, `worker.rs`, `src-tauri/git-worker/*`, `scripts/git-worker/build.mjs`, `.github/workflows/release.yml`
Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

1,362 lines of Rust (`candidate_index`, `index_publication`, `candidate_object`) have no
production caller; `candidate_policy` is used only for its NUL-config parser. The Objective-C XPC
helper is built, entitled, signed and verified in release CI, and its only entry point
`git_execution_capability` is registered in `lib.rs:575` but never invoked from the frontend. The
release ships and signs a sandboxed helper that executes nothing, and release CI can fail on its
signature while no user-facing behavior depends on it. The approved threat model no longer
requires the isolated executor for the same-user swap race.

Fix: move the executor modules and the helper behind a Cargo feature the release does not
enable, or delete them until the executor is scheduled; keep `parse_config` where it is used.

---

**O-02** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `compat` · `src-tauri/src/modules/pty/shell_init.rs:138-159`
Status: fixed in b840eb9 (batch C); test utf8_locale_leaves_an_explicit_lc_all_alone

`ensure_utf8_locale` finds the first non-empty of `LC_ALL`, `LC_CTYPE`, `LANG` in the inherited
environment; when its value is not UTF-8 it overwrites that same variable with the platform
fallback. A user who exports `LC_ALL=C` for byte-order `sort` and English tool output gets
`LC_ALL=en_US.UTF-8` in every Oarlock shell: collation, numeric, time and messages all change.
The previous code added `LANG`, which `LC_ALL` masks harmlessly.

Fix: when the effective variable is `LC_ALL`, leave it alone and warn, or replace it with the same
locale name plus `.UTF-8` when that locale exists.

---

**O-06** · Medium · ledger MAJOR · 4.5 · CONFIRMED · `over-engineering`, `compat` ·
`src/modules/terminal/ghostty/useGhosttyTerminalSession.ts:540-556`, `src/modules/terminal/lib/terminalSessionApi.ts:92`,
`src-tauri/src/modules/pty/path_drop.rs` (296 lines), `src-tauri/src/modules/pty/path_drop/wsl.rs`
Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

`dropPathsIntoGhosttySession` requires `getMode() === "prompt"` and a `pathInsertion` capture
that only the block-mode command bar registers. Plain terminals, the default tab kind, now show
"Cannot insert dropped paths" for every OS file drop; the pre-PR bracketed paste of quoted paths
is gone for them, while `AGENTS.md` still says "elsewhere a drop pastes shell-quoted paths as
before". The owner approved the verified-command-bar restriction, so this is recorded as the cost
of that decision rather than a defect. The native side verifies the foreground process group,
sole group membership and the shell executable per drop; the dialect was already captured at
spawn, and the residual risk (a drop while the cursor is inside an open quote) is a user action,
not untrusted content.

Fix: quote for the launched dialect and bracketed-paste, refusing only when a program other than
the shell owns the foreground; delete the per-drop pgrp verification.

---

**O-07** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `over-engineering` · `src/modules/editor/lib/quitBarrier.ts`,
`src/app/hooks/quitApproval.ts`, `src-tauri/src/modules/windows/quit.rs` (verification phase), `src/modules/editor/lib/documentMutations.ts:120-166`
Status: deferred (batch D): the quit seal is unchanged; only the D-11 toast for a refused close
landed

The quit seal, inert overlay, 6 s watchdog, deferred lifecycle map and the rule that a mutation
batch cancels an active seal close one window: the IPC latency between a window's final answer
and `app.exit`. A final verify ping that re-reads `dirtyRevisions()` and answers without sealing
input keeps the ordinary-concurrency guarantee. The seal is also what makes `closeWindow` return
silently (D-11) and what the "Finishing quit" overlay shows on a plain window close.

Fix: replace the seal with a verify round that re-reads revisions; drop the deferred-lifecycle
machinery.

---

**O-08** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `over-engineering` · `src/modules/editor/lib/discardCoordinator.ts`,
`src-tauri/src/modules/git/discard.rs` (1,094 lines)
Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

Non-originating windows always preserve their buffers (`preserve = true`), so the per-window
prepare barrier, 5 s native timeout, settled acknowledgements and 2 s polling buy nothing over a
single ordered discard-begin and discard-end pair on the existing `fs:mutation` stream. Only the
originating window needs revision capture, which it already holds locally.

Fix: emit begin and end events on the mutation stream and delete the coordinator.

---

**O-09** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `over-engineering` · `src-tauri/src/modules/fs/mutation_events.rs:139-193`,
`src/modules/editor/lib/recoveryTarget.ts`
Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

Native recovery pins (`fs_recovery_begin`, `changed`, `end`, each pinning a `Destination` under
the stream mutex) defend Restore and Save As against a same-user alias rename mid-write, which
the owner classed best effort. Local `recoveryTargetsChanged` already covers Oarlock-originated
mutations, and the pins are why D-17 stalls recovery.

Fix: keep the local tracker; delete the native pins.

---

**O-10** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `over-engineering` · `src-tauri/src/modules/mcp/credentials.rs` (573 lines),
`src/modules/ai/lib/chatWork.ts`, `src/modules/ai/lib/mcpRunLeases.ts`, `src/modules/ai/lib/ownedStream.ts`, `src-tauri/src/modules/mcp/leases.rs`, `src-tauri/src/modules/ai_metadata.rs:126-133`
Status: fixed in batch I (`pr-2-fixes/batch-I.md`): one run owner per turn with one native record, revision-keyed
credential accounts, durable chat metadata with at most 256 tombstones; tests listed in the batch note

The `credentialVersion` namespace rotation with staged copy and retire duplicates
`secretsRevision`, which already pins launches to a saved configuration; per-secret accounts
keyed by revision would do. One agent turn is tracked by four overlapping lifetime owners
(`chatWork`, `mcpRunLeases`, `ownedStream`, native `leases.rs`). The chat metadata revision and
tombstone gate sits on the plugin store's non-durable autosave, so it orders memory rather than
disk, and the tombstone set grows without bound.

Fix: one owner object per run; drop the namespace rotation; persist on each metadata mutate or
drop the gate.

---

**T-01** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `test-quality` · `src-tauri/src/modules/git/worktree.rs:364`, `:521`,
`src-tauri/src/modules/git/discard.rs:22`, `src-tauri/src/modules/git/commands.rs:399-418`
Status: fixed in fa07ad0 (batch A); test
commands.rs::every_work_tree_changing_command_passes_the_native_store_guard

Worktree add, worktree remove and discard execution take the native-store guard as a closure.
The tests inject a closure and assert it is called; the production wiring in `commands.rs`, which
passes `native_store::refuse_write`, is exercised by no test. A regression that drops or
mis-targets the closure keeps every test green, while the ledger counts the tests as coverage of
the guard.

Fix: test through the command-level function with the real guard, or make the guard a method on
the resolved repository.

---

**T-02** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `test-quality` · `src-tauri/src/modules/store_scope.rs:222-260`,
`src-tauri/src/modules/fs/native_store.rs:64-70`
Status: fixed in 49e7007 (batch B); test every_native_owned_file_is_refused_unless_the_page_opens_it

The store wrapper's test keeps the JS `LazyStore` call sites in sync with the allowed names, but
no test compares the wrapper's refusal list with `NATIVE_FILES`. The lists already diverge
(S-03).

Fix: one test that iterates `NATIVE_FILES` and asserts `allowed_store_path` refuses each.

---

**T-04** · Medium · ledger MAJOR · 4.0 · CONFIRMED · `test-quality` · `src/modules/terminal/lib/BoundedPtyWriter.test.ts:33-48`,
`src/modules/terminal/lib/orderedPaste.test.ts`
Status: fixed in 6eb3ea9 (batch C); test orderedPaste.test.ts "keeps the terminal alive when keys
pile up behind a stalled clipboard read"

The writer test's comment says "no more replies are taken; typing still is", but after the refused
reply the writer is permanently failed (the test's `onError` is a no-op), so the final input
assertion passes because of the failure, not the budget. No test covers reply refusal keeping
input alive, the action cap, or `deferInput` returning `true` after failure (silently swallowing
a key). `orderedPaste.test.ts` injects the clipboard and reservation steps and never exercises the
cap or a stalled read. The behavior these tests describe is the pre-PR behavior that P-02 removed.

Fix: assert that a refused reply leaves `enqueue(input)` true and `failed` false.

### Low

**S-08** · Low · MINOR · 3.0 · CONFIRMED · `security` · `src-tauri/src/modules/git/process.rs:133-188`,
`src-tauri/src/modules/git/operations.rs:266`, `:450`. `git_show_text`, `list_untracked_in` and `file_base` launch through
`run_git_guarded` with directory discovery and no `GIT_DIR`/`GIT_WORK_TREE` pin, unlike every other post-preflight launch.
Needs a `.git` swap by another process. Fix: route through `ResolvedGitDirectory::run`.

Status: fixed in 0d59983 (batch A); test
operations.rs::post_preflight_reads_stay_pinned_to_the_acquired_git_directory

**S-09** · Low · MINOR · 3.0 · CONFIRMED · `security` · `src-tauri/src/modules/git/process.rs:442-446`,
`src-tauri/src/modules/git/discard.rs:31`, `:382`, `src-tauri/src/modules/git/remote_guard.rs:353`, `src-tauri/src/modules/git/worktree.rs:539-555`.
Four preflight-to-execution windows: network commands keep `credential.helper`, `core.sshCommand` and `core.askPass`
un-overridden; Discard preflights at begin and executes later without it; the local remote's pin is dropped before the
transfer; forced worktree removal never preflights the target. All need a same-user process between check and use.

Status: fixed in b53c4e6 (batch A); test
operations.rs::discard_and_network_launches_recheck_the_configuration_at_execution

**S-10** · Low · MINOR · 2.5 · CONFIRMED · `security` · `src-tauri/src/modules/git/process.rs:572-599`,
`src-tauri/src/modules/git/operations.rs:735-745`, `src-tauri/src/modules/git/commit_guard.rs:58`. Program-naming environment
variables are not removed (`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`,
`GIT_SEQUENCE_EDITOR`, `GIT_PAGER`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_ATTR_SOURCE`); `git log --shortstat` lacks
`--no-ext-diff --no-textconv`; `merge.verifySignatures`, `tag.gpgSign` and `push.gpgSign` are not in the table. These
come from the app's own environment or run the user's own `gpg`.

Status: fixed in 98c8e64 (batch A); test
process.rs::program_naming_environment_variables_are_removed_from_every_launch

**S-11** · Low · MINOR · 2.5 · CONFIRMED · `security` · `src-tauri/src/modules/git/process.rs:626`,
`src-tauri/git-worker/apple_git.m:85`. Source Control runs whatever `git` is first on `PATH`; the verified Apple Git is
only probed. Fix: resolve once and pin, or drop the probe with O-01.
Status: fixed in 937f241 (batch A); test process.rs::every_launch_uses_the_binary_resolved_once

**S-13** · Low · MINOR · 2.0 · CONFIRMED · `security` · `src-tauri/src/modules/fs/mutate.rs:412-422`, `:370`, `:510`.
Rename, move and delete check protected identities once and then act by path, and `fs_move` checks `resolve_path(from)`
rather than the authorized target; a static alias is caught by the inode comparison.
Status: fixed in 46578a2 (batch A); test
mutate.rs::move_guards_the_authorized_entries_and_checks_again_before_acting

**S-14** · Low · MINOR · 2.0 · CONFIRMED · `security` · `src-tauri/src/modules/asset_scope.rs:83-87`,
`src/modules/terminal/lib/fontFeatures.ts:433`, `src-tauri/src/modules/asset_all_folders.rs:116-133`. Tauri's `asset:`
protocol stays enabled for font faces with workspace-root grants and re-opens by path after its scope check; with "all
folders" on, the app's own state files have no dot names and are served to previews.

Status: fixed in 79b2d15 (batch B); test the_apps_own_state_is_never_a_preview_whatever_the_settings

**S-22** · Low · MINOR · 3.0 · CONFIRMED · `security` · `src-tauri/src/modules/shell/mod.rs:437`, `:470`,
`src-tauri/src/modules/shell/session.rs:65`, `:113`, `:137`, `src-tauri/src/modules/shell/background.rs:31`, `:80`,
`src-tauri/src/modules/net/page.rs:17`, `src-tauri/src/modules/net/stream.rs:85-161`. Poisoned-lock `unwrap`s on hot
paths and inside `on_page_load` on the main thread, against the `AGENTS.md` rule; one pump panic makes every later
`bash_logs` panic, and a main-thread panic ends the app. Fix: `unwrap_or_else(PoisonError::into_inner)`.

Status: fixed in 2539f01 (batch E); test a_poisoned_cwd_lock_does_not_end_later_commands

**S-23** · Low · MINOR · 2.5 · CONFIRMED · `security` · `src-tauri/src/modules/shell/mod.rs:411-416`, `:636`,
`src-tauri/src/modules/shell/session.rs:37-50`, `:160-190`, `src-tauri/src/modules/skills/files.rs:64-78`,
`src-tauri/src/modules/skills/mod.rs:622`, `:1038-1098`. A shell session opened with no cwd starts in `$HOME` without
passing `spawn_cwd`; the cwd frame is produced by builtins the command controls (`pwd(){ echo /x; }`) and a command
ending in `\` joins the wrapper's `__oarlock_rc=$?` line; skills `files.rs` stats then re-opens by path; every
`read_skill_file` rehashes the whole project skills tree; install tokens are process-global across windows.

Status: partly fixed in 234bef8 (batch E); open: `read_skill_file` still rehashes the whole project
skills tree, `resolve_inside` still canonicalizes by path before the open, and a shell function
named `command` can still change what the cwd wrapper prints

**S-24** · Low · MINOR · 2.5 · CONFIRMED · `compat` · `src-tauri/src/modules/mcp/settings.rs:437-444`,
`src-tauri/src/modules/mcp/oauth/mod.rs:336-420`, `src/modules/ai/agents/trackedSubagent.ts:100-123`,
`src-tauri/src/modules/ai_subagents.rs:333-360`. `mcp_settings_mutate` holds the process-wide settings lock while
awaiting each server's refresh lock, which a token refresh holds for up to 30 s, blocking every spawn, open and Settings
save app-wide; a subagent whose final update IPC fails stays `running`, so every later Stop waits 30 s and blocks the
chat until the Retry toast is found.

Status: partly fixed in ff21944 (batch E); open: a subagent's final status that fails all three
retries still leaves the record running until the Retry toast is used

**D-07** · Low · MINOR · 2.0 · CONFIRMED · `data-loss` · `src/app/hooks/useTabCloseGuards.ts:209-214`, `:229-234`.
Single-tab `confirmClose` and `confirmDeleteClose` dispose without the revision recheck the many-tab path performs. The
dialogs are modal, so user input cannot land meanwhile; only a discard completion or a formatter adoption could change the
buffer. Recorded for symmetry with AP013, not as a reachable loss.

Status: fixed in 2e0543a (batch D); test useTabCloseGuards.revisions.test.ts "a single-tab
confirmation asks again when the buffer changed after the prompt"

**D-10** · Low · MINOR · 3.0 · CONFIRMED · `data-loss` · `src/settings/sections/ThemesSection.tsx:174-186`,
`src/settings/sections/importPublication.ts:142-159`, `src/modules/settings/store.ts:861-887`, `src/modules/theme/themeDeletion.ts:8-9`.
Theme deletion is three unordered steps with a trailing file delete; the selection reset is conditional on the current
selection and `reconcileThemeSelection` repairs a dangling selection from authoritative snapshots, so the residue of a
failure between steps is a leftover `.oarlock-theme` that re-creates the theme on its next save. `removeBackground`
bypasses the import lock and barrier; `setBackgroundKind` and `setBackgroundImageId` remain exported two-step writers
with no caller. Fix: delete the file before the selection reset.

Status: fixed in b7199b5 (batch D); test themeDeletion.test.ts (order test)

**D-11** · Low · MINOR · 2.5 · CONFIRMED · `data-loss` · `src/app/hooks/useAppCloseGuard.ts:200-205`,
`src/modules/editor/lib/quitBarrier.ts:13-16`. `closeWindow` returns silently when `sealEditors` fails (another window's
verification seal, or `editorMutationsPending()` during any reconcile including the initial one); the close click
produces no feedback and repeats do nothing until the seal clears.

Status: fixed in 99550b8 (batch D); test useCloseGuards.races.test.ts "a close refused by another
window's quit seal says so"

**D-12** · Low (Linux, secondary) · MINOR · 3.0 · CONFIRMED · `data-loss` · `src-tauri/src/modules/fs/linux_staging.rs:263-281`,
`:329-363`, `:113-166`. In hidden-sibling mode the candidate, already widened to the destination's final mode and ACL,
is linked into the user's directory before the rename, so a crash in that window leaves a readable draft; mode detection
sees only `.git` ancestors, so a bare dotfiles repository shows the sibling; the cleanup scans the whole destination
directory on every save with no entry cap.

Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

**D-13** · Low (Linux, secondary) · MINOR · 2.0 · CONFIRMED · `compat` · `src-tauri/src/modules/git/operations.rs:225-227`.
One filename with invalid UTF-8 anywhere in the work tree fails the entire `git status` read. macOS refuses such names.
Fix: decode per NUL-separated record and mark the bad entry.
Status: fixed in 6c20981 (batch A); test
parser.rs::one_invalid_utf8_name_is_marked_and_the_rest_of_the_status_is_kept

**D-20** · Low (Linux, secondary; documented) · MINOR · 3.0 · CONFIRMED · `compat` · ledger: R028 closed for macOS only ·
`src-tauri/src/modules/fs/copy_owned.rs:302-309`, `src-tauri/src/modules/fs/copy.rs:32-53`. Explorer copy, paste and OS
drop return `Unsupported` for every item off macOS with no fallback. Recorded because it ships as a per-item failure
rather than a disabled action.

Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

**D-21** · Low · MINOR · 2.5 · CONFIRMED · `data-loss` · `src/modules/editor/lib/recoveryTarget.ts:12-15`,
`src/modules/editor/lib/documentMutations.ts:128`, `:150`, `src/modules/spaces/lib/useSpacePersistence.ts`. Any reconcile
start invalidates every in-flight recovery, so a Save As overlapping an unrelated reconcile fails with "Recovery was
interrupted" (draft retained); a scrollback persistence failure now fails the whole close flush and shows the
"application state may be lost" warning for a convenience file.

Status: fixed in 10fde4e (batch D); test recoveryTarget.test.ts "a recovery with native history
survives an unrelated reconcile"

**P-04** · Low · MINOR · 3.0 · CONFIRMED · `data-loss` · `src-tauri/src/modules/clipboard_write.rs:34-52`,
`src/modules/terminal/ghostty/useGhosttyTerminalSession.ts:1410`. One `latest` slot per selection: a program's OSC 52
write that lands between the user's Cmd+C begin and commit supersedes the user's copy, and
`writeTerminalClipboard(text).catch(() => {})` swallows it. Approved ordering, but the loss should toast.

Status: fixed in ec4acb7 (batch C); test terminalClipboard.test.ts "tells the user when a program's
write took the clipboard first"

**P-05** · Low · MINOR · 2.0 · CONFIRMED · `compat` · `src/modules/terminal/ghostty/input/GhosttyInputController.ts:362`.
`inputRevision` bumps on every keydown including bare modifiers and arrow repeats, so app-driven input captured through
`captureGhosttyInputOwner` (breadcrumb `cd`, Rerun, a queued launcher command) is cancelled by a Shift press. Count only
keys that produce bytes.

Status: fixed in 90b59c5 (batch C); test GhosttyInputController.test.ts "counts a key as input only
when it types something"

**O-03** · Low · MINOR · 2.0 · CONFIRMED (narrow) · `compat` · `src-tauri/src/modules/app_menu.rs:38`, `:104-120`,
`src/modules/shortcuts/lib/menuBridge.ts:24-31`. The menu is built with `MenuAccelerators::default()` (all `None`) and
the bridge sends the bindings at page start, so New Window and Close Tab lack a key equivalent only in the sub-second
window before the first app page's bridge runs. Fix: seed `build()` with the platform default table.

Status: fixed in 079efb4 (batch D); test
the_menu_is_built_with_the_default_keys_before_any_page_sends_bindings

**O-12** · Low · MINOR · 2.5 · CONFIRMED · `over-engineering` · `src/modules/theme/bgImageStore.ts:54-62`,
`src/modules/theme/inspectBackgroundImage.ts:11-16`, `src-tauri/src/modules/background_image.rs:214-249`,
`src/modules/theme/SurfaceLayer.tsx:57-58`. Every window start copies the stored background image over raw IPC (up to
30 MiB) for native inspection, serialized through a two-permit budget whose permit a hung decode keeps. The validation of
already-stored bytes guards only against a tampered IndexedDB, a same-user actor. Fix: inspect at import only and store
an inspected marker or content hash with the blob.

Status: fixed in 9d07c3b (batch D); test bgImageSafety.test.ts "hands a saved background back
without inspecting it again at startup"

**O-13** · Low · MINOR · 2.0 · CONFIRMED · `compat` · `src/modules/markdown/MermaidDiagram.tsx:92-105`,
`src/modules/markdown/mermaidRender.ts:38-41`, `:121-146`. The 300 ms debounce applies to the first render and to theme
switches, not only to edits, and a render that completes after the window was hidden is discarded instead of cached, so
switching away and back re-renders every diagram after another 300 ms. Fix: debounce only when a previous key is drawn;
cache completed results even when aborted.

Status: fixed in 525128f (batch D); test mermaidRender.test.ts "render timing"

**O-14** · Low · MINOR · 2.5 · CONFIRMED · `compat` · `.github/workflows/release.yml:109-139`. The helper and app
signature verification runs after `tauri-action` has created the draft release and uploaded the bundle; a failed check
fails the job but leaves the unverified `.app` and `.dmg` attached to the draft. The tag guard gates both publishing
jobs and `OARLOCK_DISTRIBUTION_BUILD=1` is on the step that needs it. Fix: build, verify, then upload.

Status: fixed in 5bfbcc6 (batch D); test releaseWorkflow.test.ts "verifies the macOS bundle before
anything is uploaded to the release"

**O-15** · Low · MINOR · 2.0 · CONFIRMED · `over-engineering` · `src-tauri/src/modules/themes.rs:402-419`, `:448-456`.
`verify_disk` re-reads and re-parses the whole catalog (up to 50 MiB) on every snapshot and mutation and makes any
external change fatal until restart. Under the approved model a same-user writer is best effort and the conditional
writer already checks identity and version at publish. Fix: drop `verify_disk` from reads.

Status: deferred (no fix batch): left by decision; no change in batches A to E, and the notes record
no further reason

**T-05** · Low · MINOR · 2.0 · CONFIRMED · `test-quality` · `src/modules/markdown/MarkdownImage.lifecycle.test.tsx:100-104`.
The lifecycle test asserts the local-image failure latch by calling `onError` on a bare element, so it locks in the
no-retry behavior behind D-02 rather than proving recovery; no test covers `fs_watch_add` with one missing directory
among valid ones (D-22) or the DNS gate under a burst of same-host image loads (D-23).

Status: fixed in 61bc191 (batch B); test MarkdownImage.lifecycle.test.tsx (retry and latch,
fifty-badge burst)

**O-04** · Low · MINOR · 2.0 · CONFIRMED · `test-quality` · `src-tauri/tests/git_entrypoint_guard.rs`,
`src-tauri/tests/common`. The guard suites read the real `$HOME/.gitconfig` through production code while fixture
isolation covers only fixture commands; on any machine with Git LFS or global signing the positive cases fail (see S-02).
Fix: point `HOME` at a temporary directory for the test process.

Status: fixed in 813fd65 (batch A); test
git_fixture_isolation.rs::git_fixture_isolates_home_from_the_users_git_configuration

**O-05** · Low · MINOR · 1.0 · CONFIRMED · `compat` · `src/modules/ai/components/AiStatusBarControls.tsx`,
`src/modules/ai/lib/native.ts`, `src/modules/ai/tools/shell.ts`, `src/modules/terminal/block/lib/safePathCompletion.ts:2`,
`src/modules/lsp/lib/uri.ts:4`, `:40`, `src/modules/source-control/repositoryTarget.ts:21`,
`src/modules/terminal/lib/terminalLinkTargets.ts:160-167`. Six added lines contain an em-dash and three added imports reach
across modules with `../../lib/quoteShellPath`, against `AGENTS.md`; the Windows-path predicate is re-implemented in four
places, one of which already omits the UNC half.

Status: fixed in aac608c (batch E); test src/lib/windowsPath.test.ts

## Claims the second reviewers refuted

- Preview-slot replacement trusting a stale `tab.dirty` flag: `setTabs` now writes `tabsRef.current` synchronously,
  `updateTab({dirty: true})` pins the preview, and the dirty effect flushes after a discrete input event, so a click cannot
  interleave. Not a defect.
- Clipboard snapshot cross-window coherence: the OS revision is checked before and after the text read and after pixels,
  and reuse is granted only when the caller's revision equals the live `changeCount`, so another window's write
  invalidates the 1 s cache. Sound.
- The 24 `hook.<event>.enabled=false` overrides: not dead weight. Git 2.56 runs config-defined `hook.<name>.command`
  hooks, `core.hooksPath=/dev/null` does not suppress them, and `hook.<event>.enabled=false` does (`hookrepo2/`).
- LSP ordered-writer bounds (256 messages, 16 MiB, 30 s) and the 512 MiB / 50,000-message output kill: not reachable by
  rust-analyzer or tsserver in normal use. Sync is incremental, each write is acknowledged before the next, both servers
  drain stdin on a dedicated thread, and the output kill restarts with the ordinary cooldown rather than sticking.
- Watcher health recovery: a degraded backend is retried on the next watch-set change and on Retry, with coverage refresh
  emitting change events for every retained target. Reasonable without idle polling.
- Native networking: same-origin redirects, `no_proxy` on every guarded profile, per-request DNS pinning and
  page-generation tokens delivered only after `PageLoadEvent::Finished` all read as claimed.

## Ledger claims versus evidence

"Supported" means the code does what the claim says on the macOS path read here; "Partly" means the mechanism exists but
the claim overstates its reach; "Unsupported" means the code contradicts it.

| Claim (source) | Evidence | Verdict |
| --- | --- | --- |
| Repository admission runs the executable-config and hooks preflight for every native Git entry point (Git entry-point checkpoint) | `owned_repo_root` calls `commit_guard::preflight` per command (`utils.rs:94`); all 32 entry-point tests exercise it. Discard executes later on the begin-time result (`discard.rs:31,382`). | Partly |
| Invocation overrides suppress hooks, fsmonitor, signing and helpers as defense in depth (R054a) | `defense_args` (`process.rs:400-477`) adds them to every non-`config` launch; config-defined hooks run on Git 2.56 and `hook.<event>.enabled=false` suppresses them (`hookrepo2/`). Network launches omit the helper overrides (S-09). | Partly |
| Ordinary user-wide credential helpers do not by themselves block all local commits (R054a) | True for `credential.helper`; false for `filter.*`, `gpg.*.program` and `core.fsmonitor`, refused in every scope (S-02). | Partly |
| Remote URLs are read NUL-delimited, control characters rejected, only the remotes used are authorized (R234 fix) | `remote_guard.rs:76-116`, `:259-361`; fetch, pull and push run with no explicit remote (`operations.rs:681-694`, `:1022-1045`), so the inspected selection matches Git's. | Supported |
| `discover_repos` performs only filesystem walking | `operations.rs:111` launches no Git. | Supported |
| Skill installation clones without checkout, inspects, then checks out | `skills/install.rs:174-201`. The clone is a network launch without helper overrides (S-09 class). | Supported |
| The store plugin scope refuses the native-store filename and case aliases in every window (R216 passes) | Six names refused (`store_scope.rs:111-126`); nine of the fifteen inventory names are not (S-03). | Unsupported as stated |
| The forked store plugin checks every read and write through a directory descriptor, refuses symlink final entries and hard-linked files (R216) | `secure_file.rs:5-49`; applies to load, save, autosave and exit save. Write is truncate-then-write (S-12). | Supported for the stated properties |
| Workspace saves, create, rename, move, delete and copy check native-store identities, including aliases (R216) | `native_store::refuse_write` is called from each (`file.rs:322`, `mutate.rs:259-556`, `copy_owned.rs:288`); rename, move and delete then act by path (S-13). | Supported, best effort after the check |
| The secret-path deny-list applies on both read and write and is never bypassed (AGENTS.md) | Enforced in the page per tool; natively absent for `origin: "ai"` writes (S-16). | Partly |
| Oarlock's own edits keep the project trust, including the AI's approved or auto-approved writes (AGENTS.md) | `keeping_trust` takes no origin (`project_trust.rs:777-800`). Accurate, and the behavior is S-15. | Supported; the policy is the finding |
| The guarded preview scheme authorizes the opened handle, applies the dot rule to every component, reads the all-folders switch per request (R231) | `asset_all_folders.rs:235-244`, `:122-133`, `:116-118`. Open precedes authorization (S-05); no `Origin` required (S-06). | Supported for the stated properties |
| A `.pdf` request is sniffed and non-PDF content gets a sandboxed plain-text refusal with `nosniff` (R240) | `asset_all_folders.rs:251-263`, `:334-355`, test `pdf_preview_refuses_html_and_keeps_valid_pdf_content`. Any other extension falls back to `text/html` (S-01). | Supported for `.pdf` only |
| Whole responses above 50 MiB refused, 2 active and 64 admitted requests (R190) | `asset_all_folders.rs:36-66`. The 64 cap is reachable from one page (D-02). | Supported; consequence unassessed |
| macOS saves stage in the destination volume's item-replacement directory, verified by identity, made private, outside worktrees (R026-U) | `private_staging.rs:27-105`, `:189-206`, `:391-429`. | Supported |
| Linux saves use `O_TMPFILE`, a private Git common-dir or cache location, hidden sibling outside repositories, opportunistic cleanup (R026-U) | `linux_staging.rs:263-300`, `:329-363`, `:113-166` (D-12). | Supported |
| Conditional saves detect in-place edits during staging and never overwrite newer content (R046, R053) | `document_save.rs:156-196`, `:259-262`, `:279-295`. No directory sync after rename (D-03); a post-rename version failure reads as failure (D-04). | Supported for the conflict property; durability overstated |
| Background kind and image id commit in one revision; cleanup runs a revision barrier before deleting; candidates are kept on unknown outcomes (AP016) | `preferences.rs:223-231`; `backgroundCleanup.ts:11-26`; `importPublication.ts:110-128`. A post-commit error is wrapped as not committed (D-04). | Partly |
| Theme-file ingestion captures the catalog revision before reading and publishes under the per-file lock (R201) | `themeFileIngest.ts:16-51`, `themes.rs:39-59`, `:421-483`. | Supported |
| Bulk-close confirmation uses close revisions and asks again for new edits (R020, AP013) | `useTabCloseGuards.ts:145-202` for Close Others and Close Right; space deletion and the pane path do not prompt at all (D-01, D-08). | Partly |
| Mutation delivery retains later events after a failure and reconciles open documents on a sequence gap (R038a/b) | `documentMutations.ts:120-166`, `reconcile.rs:69-158`. The walk's shared limit and ignore-nothing policy fail on large workspaces and stall recovery (D-05). | Supported; limits unassessed |
| Git worktree add, remove and discard check selected trees against native-store identities (R216 Git) | `commands.rs:399-418`, `discard.rs:36-58`. Tests inject the guard (T-01). | Supported in code; coverage overstated |
| Terminal reply overflow fails visibly and never returns a truncated stream (R095) | `oarlock.zig:993-997`. It fails visibly and permanently, with no reset (P-01). | Supported; consequence is the finding |
| The terminal writer stops and reports a persistent error on queue overflow rather than sending later input (R076) | `BoundedPtyWriter.ts:120-131`. Accurate; the trigger set now includes an ordinary large paste and a reply flood (P-02). | Supported; the policy is the finding |
| The full native suite and the full frontend suite pass (every checkpoint) | Not re-run here. The four Git guard suites pass as shipped: 32, 8, 15 and 2 tests (`guard-suites.log`). | Partly verified |

## Not reviewed, and why

- Windows and WSL code paths (`#[cfg(windows)]`, `wsl.exe` launches, ConPTY): outside the release scope the owner set.
  One exception is noted inside D-16: the non-Unix `pin_root` is `Unsupported`, so the app cannot start on Windows at
  all, which is not silent and is recorded there.
- The Vim forks under `packages/codemirror-vim*` beyond their close and save paths: a compatibility corpus, not a
  security or data-loss boundary.
- Branding assets, generated icons and documentation prose (255 of the 1,088 files).
- Runtime behavior of the packaged, signed application: every reproduction ran against source, disposable fixtures or an
  isolated WKWebView, never the bundled app.
- Linux and GTK runtime paths were read but not executed; their findings are tagged secondary.
- The full native and frontend suites were not re-run; only the four Git guard suites and one HOME-overridden
  reproduction ran here.

## Reproduction index

All under `/private/tmp/claude-501/-Users-darkspadez-Documents-qops-git-oarlock/a94ee842-85eb-4f9a-b77c-7eb117bd4e42/scratchpad/`:

| Finding | Artifact |
| --- | --- |
| S-01 | `webkit-probe/probe.swift`, `webkit-probe/attacker_server.py`, `webkit-probe/files/`, `webkit-probe/probe.log`, `webkit-probe/hits.log` |
| S-02, O-04 | `lfs-home/.gitconfig`, `lfsrepo/`, `repro-lfs-global.log` |
| D-02 | `webkit-probe/probe2.swift` (150 concurrent scheme requests) |
| Claims table (config hooks) | `hookrepo2/` (Git 2.56.0: `hook.<name>.command` runs; `hook.<event>.enabled=false` suppresses it; `core.hooksPath=/dev/null` does not) |
| Claims table (suites) | `guard-suites.log` |
