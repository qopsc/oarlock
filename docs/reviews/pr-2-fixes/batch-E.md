# Batch E: AI tools, project trust, MCP, shell, net proxy

Branch `worktree-agent-aad8ee34ada00e277`, from `review/codex-fixes` at fe147a5.

## 1. Findings closed

| ID | One line | Fix location | Test | Commit |
| --- | --- | --- | --- | --- |
| S-15 | The AI's writes no longer keep project trust for `.mcp.json`, skills folders and `AGENTS.md`; editor and app writes still do | `project_trust.rs` (`keeping_trust` and `keep_through` take the origin), `fs/file.rs` (`fs_write_file`, `fs_save_document`), `fs/mutate.rs` (`fs_create_dir`; `fs_create_file` is app-only) | `project_trust::tests::the_ais_own_writes_ask_again_where_the_editors_keep_the_answer` (the old `oarlock_s_own_edits_keep_the_answer_on_mcp_json` still locks the app side) | 2c28542 |
| S-16 | The AI's gates refuse the secret-path deny-list natively on the requested and real path | `workspace.rs` (`Gates.protect_secrets`, `screen`; `authorized_existing`, `authorized_entry`, `authorized_new`, `authorized_write_target` through them) | `workspace::auth_tests::ai_gates_refuse_secret_paths_natively_and_app_gates_do_not` | d432776 |
| D-14 | Plan Apply chains same-file edits onto the running candidate, saves through `fs_save_document` with the expected version, and reports a stale version per edit | `src/modules/ai/store/planStore.ts`, `tools/editOps.ts` (new pure core), `tools/edit.ts`, `tools/fs.ts`, `lib/native.ts`, `lib/staleFile.ts` | `planStore.test.ts` ("same-file edits and stale versions", 5 cases), `planStore.failures.test.ts`, `editOps.test.ts`, `edit.test.ts`, `fs.test.ts`, `native.test.ts` | 2738438, 7f0457e |
| D-09 | AI `write_file` and `edit` read versioned and save over that version (the model's read version for `write_file`; null means create only) | same files as D-14; `fs/file.rs` `fs_save_document` gains `origin` | `fs.test.ts` (write_file cases), `edit.test.ts` ("edit tool concurrent changes"), `native.test.ts` | 2738438 (same commit as D-14, they share the code) |
| S-17 | `bash_kill` and `bash_logs` refuse a job another chat started | `shell/background.rs` (`reachable_by`), `shell/mod.rs` (`shell_bg_logs`, `shell_bg_kill` take `chat_id`), `tools/shell.ts`, `lib/native.ts` | `tests/shell_background.rs::a_job_is_reachable_only_from_the_chat_that_started_it`, `shell.test.ts` | 9187280 |
| S-18 | The trust prompt shows a stdio server's env; loader variables (`DYLD_*`, `LD_*`, `PYTHON*`, `PATH`, `NODE_OPTIONS`, `PERL5OPT`, `RUBYOPT` and a few more) make the entry unusable | `mcp/project.rs` (`describe`, `is_loader_variable`, `loader_variable_problem`, `parse`) | `mcp::project::tests::the_prompt_shows_the_environment_a_server_is_started_with`, `a_project_server_cannot_set_a_variable_that_loads_code` | f30f72f |
| S-19 | Only a path the picker command issued (one shot, per window, 5 min, 256 at most) lets an import authorize its folder | `fs/attachment.rs` (`PickedFiles`, `ai_pick_attachment_files`, `ai_import_attachment`) | `fs::attachment::tests::only_a_path_the_picker_issued_can_authorize_and_only_once`, `a_pick_expires_and_the_list_is_bounded` | 8a11211 |
| S-20 | `project_trust_status`, `project_trust_decide` and the skills commands resolve their root through the workspace registry | `project_trust.rs` (`resolve_authorized_project`), `skills/mod.rs` (`project_of`, `skills_list`) | `project_trust::tests::a_root_the_registry_does_not_authorize_is_not_a_project` | 3a62735 |
| S-21 | `allow_private` for AI endpoint calls and `lm_ping` is decided natively from the host and stays the class the host first had; the page no longer sends it | `net.rs` (`endpoint_allows_private`, `HostClasses`), `lib/proxyFetch.ts`, `lib/agent.ts`, `lib/endpointModels.ts` | `net::tests::a_host_keeps_the_class_it_first_had`, `the_endpoint_host_decides_private_access_not_the_page`, `proxyFetch.test.ts` | 0a11e55 |
| S-22 | Poisoned `std` locks recover on the shell, session and AI stream hot paths; `net/page.rs` already did | `shell/background.rs`, `shell/session.rs`, `shell/mod.rs`, `net/stream.rs` | `shell::session::tests::a_poisoned_cwd_lock_does_not_end_later_commands` | 2539f01 |
| S-23 | A no-cwd shell session passes `spawn_cwd` for its default home; the cwd frame uses `command pwd`/`command printf` and a blank line so a trailing backslash cannot swallow it; skill installs belong to the window that started them; `read_text` opens before it stats | `shell/mod.rs`, `shell/session.rs`, `skills/mod.rs` (`take_owned`), `skills/files.rs` | `shell::session::tests::a_command_cannot_forge_the_cwd_or_swallow_the_wrapper`, `skills::tests::an_install_can_be_committed_or_cancelled_only_by_the_window_that_started_it` | 234bef8 |
| S-24 | A Settings save gives up on a stuck token refresh after 3 s (one error, the settings lock freed); a subagent's final status is retried (250 ms, 1 s) before the Retry toast | `mcp/settings.rs` (`hold_all`), `src/modules/ai/agents/trackedSubagent.ts` | `mcp::settings::tests::a_save_gives_way_to_a_stuck_refresh_instead_of_holding_the_settings_lock`, two cases in `trackedSubagent.test.ts` | ff21944 |
| O-05 | One Windows-path predicate in `src/lib/windowsPath.ts` used by the four consumers and `mcp/lib/config.ts`; `safePathCompletion.ts` imports `@/modules/terminal/lib/quoteShellPath`; every em-dash the PR added in files this batch owns is gone | `src/lib/windowsPath.ts`, the consumers, `ai/components/AiStatusBarControls.tsx`, `ai/config.ts` and its test, `ai/lib/native.ts`, `ai/store/chatStore.ts`, `ai/tools/shell.ts` | `src/lib/windowsPath.test.ts`; consumers' existing tests; the U+2014 grep over this batch's diff finds nothing | aac608c |

D-14 and D-09 are one commit because both rewrite the same read and save path (`readFile` versioned, `writeFile` through `fs_save_document`); splitting them would leave a commit that does not type-check.

## 2. Findings left open, or closed in part

- S-23, not done: every `read_skill_file` still rehashes the whole project skills tree (a cache keyed on the tree's stamps is its own change); `skills/files.rs` `resolve_inside` still canonicalizes by path before the open (only `read_text` now opens first); a command that defines shell aliases or a function named `command` can still change what the wrapper prints, which only lets it name an existing folder, as `cd` does.
- S-16 does not cover `WorkspaceRegistry::authorize_opened`: it is a registry method with no origin, reached by user choices only (`workspace_authorize`), and it authorizes folders, not files; the AI gates refuse the secret file inside them either way.
- S-17: `bash_list` stays process-wide (the model needs it to avoid duplicate dev servers); it shows other chats' command lines but cannot touch their jobs.
- D-09: `write_file` over a binary or oversized existing file is now refused (the read that supplies the version cannot version it); it used to overwrite. A user edit between the model's read and its `write_file` now makes the write fail with "changed on disk... Read it again".
- S-24 part 2 is mitigated (retries), not made structural: a final update that fails all three attempts still leaves the record running until the Retry toast is used.
- Em-dashes the PR added outside this batch's ownership, left alone: `src/modules/shortcuts/shortcuts.ts` (comment), `src/settings/sections/AboutSection.tsx` ("Check failed ..."), `src/settings/sections/ModelsSection.tsx` ("Optional ...").
- Ownership exception: `scripts/ipc-profile/smoke.ts` lost its `createProxyFetch({ allowPrivateNetwork: true })` call (one import and one line) because S-21 removed that option; without it `check-types` fails.
- Not run: Windows and Linux (the Windows-only `command.lock().unwrap()` in `background.rs` was changed by the same substitution but not compiled here). `cargo nextest` is not installed on this machine; `cargo test --locked` was used.

## Rework after review (E-1 to E-6 and two Lows)

| Item | Fix | Test | Commit |
| --- | --- | --- | --- |
| E-1 (S-18) | `describe` puts one `sets NAME=value` line per env entry before the command line; `ItemEntries` renders those lines unclamped and only clamps the command; the refused set gains `NPM_CONFIG_*`, `UV_*`, `PIP_*`, `GIT_*`, `HOME`, `XDG_CONFIG_HOME`, `ZDOTDIR`, `DOTNET_STARTUP_HOOKS`, `CLASSPATH`, `PERLLIB` (case-insensitive) | `ProjectTrustPrompt.test.tsx` "shows a server's environment even when its command line is long"; `mcp::project::tests` (prompt text, the new names) | c211743d |
| E-2 (D-14/D-09) | Plan mode always reads the file for `originalContent` and keeps the cached version as `baseVersion` | `fs.test.ts` "shows the plan review the file as it is, keeping the version the model read" | ef303bfd |
| E-3 | `native.writeFile` sends `source: "ai"`. Consumers: `useEditorFileSync` reloads on any source but `"editor"`, so clean editors reload at once as for the old `fs_write_file` (no source); `useThemeFileEditing` ingests only `"editor"`, so AI edits to theme files are not taken as user saves, as before | `native.test.ts` (exact `fs_save_document` arguments) | 7682315a |
| E-4 | `statusWhenAuthorized` waits for `authorizationSettled(root, env)` before `project_trust_status`; `SkillsWatcher` uses it | `statusWhenAuthorized.test.ts` | aeb7e329 |
| E-5 | `fs_grep` and `fs_glob` with origin AI skip paths that fail `secret_paths::readable` (hidden names were already skipped by the walker, so the test uses `server.pem` and `credentials`); `tests/fs_search.rs` got thin shims for the new `protect_secrets` argument | `fs::grep::tests::the_ais_searches_skip_secret_files_and_the_apps_do_not` | cb688aa6, 9d180660 |
| E-6 | A non-stale failure after another edit to the same file landed says the edit has to be rejected and asked for again | `planStore.test.ts` (the "no longer applies" case) | c0b5170d |
| S-15 Low | `project_trust::tests::the_file_commands_pass_their_callers_origin_to_keeping_trust` reads the command sources (no mock app runtime is available without a `Cargo.toml` change) and asserts `fs_write_file`, `fs_save_document` and `fs_create_dir` pass `origin` and only `fs_create_file`, which takes none, names `Origin::App`. It catches a wrong or dropped argument, not behaviour. | same | dca166e6 |
| Nit | The two terminal tests import `@/modules/terminal/lib/quoteShellPath` | existing tests | 07c17639 |

`fs/grep.rs` and `tests/fs_search.rs` are outside the stated ownership; E-5 asks for the grep and glob walkers, so they were edited minimally.

## 3. AGENTS.md edits

1. Anchor: `### Two-process model`, bullet `fs::tree::*` ... `fs::file::*`, the sentence beginning "`fs_write_file`, `fs_create_file` and `fs_create_dir` keep the project trust". Replace that sentence and the one after it with:

   > `fs_write_file`, `fs_save_document`, `fs_create_file` and `fs_create_dir` keep the project trust (`project_trust::keeping_trust`) for the app's own calls only: when the change lands in an item of a project a window has open (its `AGENTS.md` or `.mcp.json` written or created, or a file or folder made inside its `.claude/skills` or `.oarlock/skills`) and the user allowed what the item held (or it held nothing), the item as the change leaves it is allowed too, so the editor's save and autosave and New File and New Folder do not ask again. A write with `origin: "ai"` (the AI's approved or auto-approved writes and folders, plan mode's Apply, `/init`) never keeps it: model output cannot author what the trust prompt exists to confirm, so the next run shows the prompt. No other command keeps trust.

2. Anchor: same bullet, "judged on the real path (links followed, `..` resolved, a WSL path by its host path), through the registry's gates". Append after the list of gates:

   > The AI's gates (`origin: "ai"`) also refuse the secret-path deny-list natively (`Gates.protect_secrets`, `secret_paths::readable`) on the requested and the real path, for read, write, create, rename, delete and canonicalize, so a tool that forgets the page's check still cannot reach `.env` or `.ssh`.

3. Anchor: `### AI subsystem`, bullet "**Tools** (`tools/tools.ts`)", "`lib/security.ts` is a deny-list refusing obvious secret paths". Append:

   > The same list is enforced natively for the AI's file calls (see `fs::*`), and the AI's `fs_grep` and `fs_glob` skip secret files under an authorized root. The AI's saves carry `source: "ai"`, so open editors reload them at once and a theme file the AI wrote is not taken in as the user's save. The AI saves through `fs_save_document` with the version it read (`readFile` with `versioned`; `write_file` uses the version in its read cache, else the one on disk now, and `null` means create only), so a file changed meanwhile is refused with a stale-version error and never overwritten. Plan mode queues edit operations with the version they were derived from, and Apply runs them in order onto one running buffer per file, reporting a stale version per edit. `bash_kill` and `bash_logs` carry the chat id and refuse a job another chat started (`BackgroundProc::reachable_by`).

4. Anchor: `### Two-process model`, bullet `shell::shell_run_command` ... `shell::shell_session_*`. Append to the persistent-agent-shell sentence:

   > A session opened with no cwd starts in the home folder only if the gates reach it. The cwd frame is printed with `command pwd -P` and `command printf` after a blank line, so a command that redefines `pwd` or ends in a backslash cannot forge or swallow it.

5. Anchor: bullet `net::*`, "AI HTTP proxy with SSRF guard". Append:

   > Whether an AI endpoint may reach private and loopback addresses is decided natively from the host (`net::endpoint_allows_private`), never from the page: a host is private when it resolves to the user's network the first time this process sees it and keeps that class, so a public name that later answers with a LAN address is refused instead of receiving the request and its credentials. `lm_ping` uses the same rule.

6. Anchor: bullet `mcp::*`, "A project's `.mcp.json` (`mcp/project.rs`, Claude Code's format) is a project trust item". Append:

   > The trust prompt lists a stdio server's environment (names and values), one `sets NAME=value` line each, before the command line and never clipped, so a long command cannot push it out of view. A project server may not set a variable that changes what the program loads or runs (case-insensitive; prefixes `DYLD_`, `LD_`, `PYTHON`, `NPM_CONFIG_`, `UV_`, `PIP_`, `GIT_`; names `PATH`, `HOME`, `XDG_CONFIG_HOME`, `ZDOTDIR`, `NODE_OPTIONS`, `NODE_PATH`, `PERL5OPT`, `PERL5LIB`, `PERLLIB`, `RUBYOPT`, `RUBYLIB`, `BASH_ENV`, `ENV`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `_JAVA_OPTIONS`, `CLASSPATH`, `DOTNET_STARTUP_HOOKS`); such an entry reads as "Cannot be used" and is never started. A Settings save waits at most 3 s for a server's token refresh before it gives way with an error, so a refresh stuck on the network cannot hold the settings lock for every spawn and save.

7. Anchor: bullet `skills::*` ... `project_trust::*`, "`project_trust_status`". Add: "The root a page names for `project_trust_status`, `project_trust_decide` and the skills commands must be a folder the workspace registry authorizes (`resolve_authorized_project`); otherwise there is no open project for that window. A staged skill install can be committed or cancelled only by the window that started it."

8. Anchor: `### AI subsystem`, "**Composer** (`lib/composer.tsx`)", "Picked files grant their selected folder once" (in the attachment paragraph at the end of the resource-ownership section): replace with "A picked file grants its selected folder once, and only if the picker command issued that path to the same window (a one-shot native token, five minutes, 256 at most); the page's `picked` flag alone authorizes nothing."

9. Anchor: `### Known gotchas`, "**Panics**": append "The shell and AI stream hot paths (`shell/*`, `net/stream.rs`) recover poisoned `std` locks with `unwrap_or_else(PoisonError::into_inner)`."

## 4. docs/architecture/security-model.md edits

1. Anchor: section "Skills and project trust", the sentence that says Oarlock's own edits keep an answer (including "the AI's approved or auto-approved writes"). Replace with:

   > Oarlock's own edits (the editor's save and autosave, New File, New Folder) keep an answer when the previous content was allowed or held nothing. Edits the AI makes (`origin: "ai"`: approved or auto-approved writes and folders, plan mode's Apply, `/init`) never do: the item as the AI left it asks again, so a repository's prompt injection cannot write an MCP server definition and have it started without the trust prompt.

2. Anchor: the table row or paragraph on the secret-path deny-list ("applies on both read and write"). Add: "The AI's native gates enforce it too (`Gates.protect_secrets`), on the requested and the real path, so it no longer depends on each tool calling the page's check."

3. Anchor: the MCP section, "A project's `.mcp.json`". Add: "The prompt shows each stdio server's environment, and loader variables (`DYLD_*`, `LD_*`, `PYTHON*`, `PATH`, `NODE_OPTIONS` and similar) make an entry unusable, because an environment variable can run code beside the command the user read."

4. Anchor: the AI network section ("SSRF guard", "allow private"). Add: "`allow_private` for AI endpoints is derived natively from the host and pinned to the class the host had when first seen; the page cannot request private access."

5. Anchor: the background jobs section. Add: "`shell_bg_logs` and `shell_bg_kill` take the chat id and refuse a job another chat started. `bash_list` stays process-wide and read-only."

6. Anchor: the attachment import section. Add: "The picker issues a one-shot native token per picked path and window; `ai_import_attachment` authorizes the file's folder only against such a token."

## 5. Checks run

Run from the batch worktree. The machine has no global git-lfs or signing config that breaks the guard suites, so no `HOME` override was needed (the harness also refused one).

- `bun run lint` ended with `Found 80 warnings.` and no errors (the branch baseline is 80 warnings).
- `bun run check-types` printed `$ tsc --noEmit && tsc --noEmit -p scripts/tsconfig.json` and no errors.
- `bun run test`:
  ```
   Test Files  646 passed (646)
        Tests  6153 passed | 2 skipped (6155)
  ```
- `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings` ended `Finished \`dev\` profile [unoptimized + debuginfo] target(s)` with no warnings.
- `cd src-tauri && cargo nextest run --locked`: `error: no such command: \`nextest\``. Fallback `cargo test --locked --no-fail-fast`:
  ```
  test result: ok. 1605 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out   (lib)
  test result: ok. 25 passed (fs_search), 2 passed (ghostty_artifacts), 8 passed (git_ai_diff), 1 passed (git_candidate_object),
  32 passed (git_entrypoint_guard), 8 passed (git_executable_refusal), 1 passed (git_fixture_isolation), 2 passed (git_literal_names),
  61 passed (git_operations), 5 passed (git_optional_reads), 15 passed (git_remote_scope), 2 passed (git_status_limits),
  2 passed (git_store_aliases), 8 passed (shell_background), 15 passed (oarlock_cli), 10 passed (oarlock_control_protocol)
  ```
  every other result line `0 failed`.
- U+2014 gate: a scan of every added line in `git diff fe147a5` over `src`, `src-tauri/src`, `scripts` and `docs` finds none.
