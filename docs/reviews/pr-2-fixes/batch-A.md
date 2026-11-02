# Batch A: Git guard and native mutation guards

Branch `worktree-agent-ac01e34c390a513a6`, based on `review/codex-fixes` at fe147a5 (the worktree
was created from `main` and reset to fe147a5 before any work).

## 1. Findings closed

| ID | One line | Fix location | Test | Commit |
| --- | --- | --- | --- | --- |
| S-02 | User-wide `filter.*`, `diff.*`, `merge.*.driver`, `gpg.*`, `core.fsmonitor` and `commit.gpgSign` no longer refuse native Git; repository scope still does | `git/commit_guard.rs` `executable_setting` | `git_executable_refusal.rs::user_scope_lfs_signing_and_fsmonitor_settings_are_accepted` (reviewer's `lfs-home` reproduction; the repository-scope cases in `commit_refuses_configured_executable_classes` still pass) | e284cbf |
| O-04 | Git fixtures point `HOME`, `XDG_CONFIG_HOME` and `USERPROFILE` at an empty temp dir once per test process | `tests/common/mod.rs` `isolate_home` (called from both fixtures) | `git_fixture_isolation.rs::git_fixture_isolates_home_from_the_users_git_configuration` | 813fd65 |
| S-07 | Every guarded launch passes `submodule.recurse`, `fetch.recurseSubmodules` and `push.recurseSubmodules` as false | `git/process.rs` `defense_args` | `process.rs::submodule_recursion_is_off_for_every_guarded_command` | 70dc926 |
| S-08 | `git_show_text`, `list_untracked_in` and `file_base` run through `ResolvedGitDirectory::run` (GIT_DIR/GIT_WORK_TREE pinned, identity checked at spawn); new `run_git_in_capped`; the unused `run_git_capped` is removed | `git/process.rs`, `git/operations.rs` | `operations.rs::post_preflight_reads_stay_pinned_to_the_acquired_git_directory` | 0d59983 |
| S-09 | Discard re-preflights at execution; network launches re-preflight right before spawning; local remote pins are kept and validated after the transfer; forced worktree removal preflights the target | `git/operations.rs` (`discard_owned`, `run_network`, `validate_remote_pins`), `git/remote_guard.rs` (`inspect` returns the pins), `git/worktree.rs` (`remove_with_guard`) | `operations.rs::discard_and_network_launches_recheck_the_configuration_at_execution`, `operations.rs::a_local_remote_stays_pinned_for_the_whole_transfer`, `worktree.rs::forced_removal_refuses_a_target_worktree_with_executable_configuration` | b53c4e6 |
| S-10 | Ten program-naming variables are scrubbed from every launch (host and WSL `env -u`); `git log` passes `--no-ext-diff --no-textconv`; `merge.verifySignatures`, `tag.gpgSign`, `push.gpgSign` join the repository-scope table | `git/process.rs` `ISOLATED_GIT_ENV`, `git/operations.rs` `LOG_FLAGS`, `git/commit_guard.rs` | `process.rs::program_naming_environment_variables_are_removed_from_every_launch`, `operations.rs::history_stats_never_run_a_diff_driver_or_converter`, three new cases in `git_executable_refusal.rs::commit_refuses_configured_executable_classes` | 98c8e64 |
| S-11 | The `git` binary is resolved once from the absolute entries of `PATH` into a `OnceLock` and every launch uses that path | `git/process.rs` `git_program`, `find_on_path` | `process.rs::path_search_takes_the_first_absolute_executable_and_skips_relative_entries`, `process.rs::every_launch_uses_the_binary_resolved_once` | 937f241 |
| S-13 | Rename, move, delete and batch delete guard the authorized entry (resolved parent plus name) and run the guard again immediately before the mutating call; `fs_move` no longer guards the raw `resolve_path` | `fs/mutate.rs` `rename_guarded`, `fs_move_checked`, `delete_path_guarded`, `authorized_entry_path`, `fs_delete_batch_checked` | `mutate.rs::move_guards_the_authorized_entries_and_checks_again_before_acting`, `mutate.rs::rename_and_delete_stop_when_the_guard_refuses_at_the_moment_of_acting` | 46578a2 |
| D-13 | Porcelain status is decoded lossily as a whole; entries whose name was not UTF-8 get the label "Unreadable name" and every other entry is kept; the three callers use `parse_porcelain_v2_bytes` | `git/parser.rs`, `git/operations.rs`, `git/worktree.rs` | `parser.rs::one_invalid_utf8_name_is_marked_and_the_rest_of_the_status_is_kept`, `parser.rs::valid_utf8_status_is_never_marked_unreadable` | 6c20981 |
| D-17 | The stream lock is no longer held across the filesystem mutation. A mutation claims its paths (overlap = same path or ancestor/descendant) and waits only for overlapping in-flight operations; the lock is taken to claim, to read recoveries and to assign the sequence and publish. Recovery `begin` claims its target and pins outside the lock. A failed `emit` is counted and logged and the sequence still advances so windows see a gap | `fs/mutation_events.rs` (`Claim`, `Stream::claim`, `apply_tracked`, `begin`, `transact`) | `a_running_mutation_does_not_hold_the_stream_lock`, `unrelated_mutations_overlap_while_related_ones_wait_their_turn`, `a_recovery_waits_for_a_running_mutation_of_its_target`, `a_failed_broadcast_is_counted_and_leaves_a_visible_sequence_gap`, `concurrent_mutations_publish_in_commit_order` (now under a root claim) | 4887ffe |
| T-01 | Source pin of the three production call sites (add, remove, discard execute) and branch checkout to `native_store::refuse_write` | `git/commands.rs` test module | `commands.rs::every_work_tree_changing_command_passes_the_real_native_store_guard` | fa07ad0 |

Notes on judgment calls:

- S-02 also keeps the `-c core.fsmonitor=false` and `-c commit.gpgSign=false` invocation overrides
  (they were already in `defense_args` and `run_guarded_commit`). `core.hooksPath`, `hook.*` and
  `core.gitProxy` stay refused in every scope, as the review did not list them.
- S-07 uses the `-c` overrides, not `--ignore-submodules=all`: `count_changes` for worktree removal
  deliberately counts submodule changes. A submodule's own `filter.*` and `merge.*.driver` still
  have no override (as the review states, a clone cannot seed them).
- S-09 cannot override the user's credential helper, `core.sshCommand` or `core.askPass` on network
  launches without breaking authentication, so the fix is the re-preflight immediately before spawn
  (the repository-scope check). A same-user process can still change config between that check and
  Git reading it.
- S-10 removes `GIT_SSH_COMMAND` and `GIT_SSH` from the environment as listed in the review. A user
  who relied on those variables set in the app's own environment must use `core.sshCommand` or
  `~/.ssh/config` instead.
- D-17: the review suggested "hold the lock only to allocate the sequence and to publish; order with
  a ticket". A pure ticket would let two mutations of the same path commit in the opposite order of
  their events (rename A to B racing B to C). Path claims keep commit order equal to publish order
  for anything that conflicts and still unblock everything else. On emit failure the sequence
  deliberately still advances: the sequence gap is how listeners learn they missed an event, and
  not advancing would lose it silently.
- D-13: macOS refuses non-UTF-8 names, so the test is a byte fixture on the parser, as planned.
- `fs/mutate.rs`: besides the rename, move and delete bodies (lines 354 to 600), I touched the tests
  that call the changed helpers (`rename`, `delete_path`, `fs_move_impl` remain as `#[cfg(test)]`
  wrappers, so no existing test line changed) and added two tests inside the file's test module.

## 2. Findings left open with reason

- T-01 is closed by the rework below (the first version only pinned call sites by source; that
  limitation no longer applies).
- S-09 residual: the preflight-to-Git-read window on network launches and Discard remains for a
  same-user process that edits config in that window (stated in the section 1 notes).

## 3. AGENTS.md edits

For the merger to apply (AGENTS.md is not touched in this batch).

1. Section "Architecture", bullet `git::commands::*`, anchor "Git runs with a 30 s timeout (network
   commands 120 s". Append after the sentence that ends "Windows still kills git alone.":

   > Source Control launches one `git`, found on `PATH` once (absolute entries only) and then pinned
   > for the process (`git_program` in `process.rs`). Every launch also scrubs the variables that name
   > a program Git would run (`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`,
   > `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `GIT_PAGER`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`,
   > `GIT_ATTR_SOURCE`) and turns submodule recursion off (`submodule.recurse`,
   > `fetch.recurseSubmodules`, `push.recurseSubmodules`).

2. Same bullet, anchor "All gated through the workspace authorization registry." Append:

   > The configuration preflight refuses `filter.*`, `diff.*` drivers, `merge.*.driver`, `gpg.*`
   > programs, `core.fsmonitor`, `commit.gpgSign`, `merge.verifySignatures`, `tag.gpgSign` and
   > `push.gpgSign` only when the repository (its local, worktree or included files) sets them; the
   > same settings in the user's own configuration (Git LFS, SSH or GPG signing, a monitor) are trusted
   > like `credential.helper`. Hooks, `core.hooksPath` and `core.gitProxy` are refused in every scope.
   > Discard, network launches and forced worktree removal run the preflight again at execution, and
   > local remotes stay pinned for the whole transfer. The post-preflight reads (`git show`, the untracked
   > listing, the file base for the change gutter) run pinned to the acquired Git directory like every
   > other launch. `git status` is decoded per NUL record: an entry whose name is not UTF-8 shows
   > as "Unreadable name" and the rest of the list is kept.

3. Section "Architecture", bullet `fs::mutate::*` / the paragraph beginning "Review 49 implements the
   approved cross-window document mutation contract", anchor "A small native mutex orders entry
   mutation plus broadcast, so concurrent commands cannot publish B->C ahead of A->B." Replace that
   sentence with:

   > Entry mutations claim their paths (`mutation_events.rs`): operations on the same path, or on a
   > path and one of its ancestors, run one at a time from claim to publish, so B->C cannot publish
   > ahead of A->B, while unrelated ones overlap. The stream lock is held only to claim, to record
   > and to assign the sequence and publish, never across the filesystem call, so deleting a large
   > folder stalls no other window. Pending recovery acquisition claims its target the same way. A
   > failed broadcast is logged and counted but still advances the sequence, so windows see a gap.

4. Section "Explorer mutation policy (macOS release)", anchor "rename, move and delete check
   authorized entries and publish the existing document mutation events". Append:

   > They also look at the native-store guard again on the authorized entry (resolved parent plus
   > name) immediately before the rename, move or removal, not only once at the start.

## 4. docs/architecture edits

1. `docs/architecture/security-model.md`, Git section (the paragraph that lists what the preflight
   refuses): replace the statement that user-wide filter, signing and fsmonitor settings are
   refused with the repository-scope rule from AGENTS.md edit 2, add the pinned `git` binary and the
   scrubbed variables from edit 1, and note that network launches keep the user's credential helper,
   `core.sshCommand` and `core.askPass` and rely on the re-preflight immediately before spawn.
2. `docs/architecture/two-process-model.md`, command reference for `fs_rename`, `fs_move`,
   `fs_delete` and `fs_delete_batch`: add that they publish through path claims (AGENTS.md edit 3)
   and re-check the native-store guard at the moment of acting.
3. `docs/contributing/testing.md`, core-subsystem invariants: Git guard suites must not read the
   developer's `$HOME` configuration; `tests/common/mod.rs` `isolate_home` is the one place that
   points `HOME`, `XDG_CONFIG_HOME` and `USERPROFILE` at an empty directory, and every Git fixture
   goes through it.

## 5. Checks run

All run in `src-tauri` of this worktree. No `.ts` file was touched, so the frontend checks were not
run. `cargo nextest` is not installed on this host, so the documented fallback was used.

```
cargo clippy --all-targets --locked -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.23s
```

```
cargo test --locked -- --test-threads=1
test result: ok. 1608 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 76.95s
test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s      (fs_search)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.27s       (git_ai_diff)
test result: ok. 32 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.06s      (git_entrypoint_guard)
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.64s       (git_executable_refusal)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s       (git_fixture_isolation)
test result: ok. 61 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.34s     (git_operations)
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.69s       (git_optional_reads)
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.73s      (git_remote_scope)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.22s       (git_store_aliases)
```

(the remaining test binaries also report `ok`, no failures.) A parallel `cargo test --locked --tests`
run once showed `modules::fs::watch::macos::tests::every_stream_reports_a_usable_resume_point`
failing; it passed on immediate rerun and in the serial full run above (the intermittent macOS
FSEvents test the ledger already records).

## 6. Rework after review (commits on top, none rewritten)

| Item | Change | Test | Commit |
| --- | --- | --- | --- |
| D-17-R1 | `apply_tracked` snapshots the ids of the recoveries that exist when it claims its paths and judges only those at publish; recoveries registered meanwhile cannot overlap the claim (their `begin` waits) and are left alone | `mutation_events.rs::an_unrelated_mutation_does_not_invalidate_a_recovery_registered_meanwhile` | 14f71a4 |
| TQ-R1 | The unrelated-mutation leg of the overlap test runs on a thread and waits with `recv_timeout`, so a broken claim fails instead of hanging | `unrelated_mutations_overlap_while_related_ones_wait_their_turn` | 14f71a4 |
| T-01-R1 | `fs/native_store.rs` (additive, per the granted exception): `StoreDirs` (built by `StoreDirs::under` from the data, local data and config folders plus the extra protected paths), `store_dirs(app)` and the pure `refuse_write_in(&dirs, target)`; `refuse_write` delegates to them. `git/utils.rs::store_guard` builds the closure from the pure function and is what `git_worktree_add`, `git_worktree_remove` and the discard worker pass. The source pin is kept as defense in depth, searches only the production half of each file and matches the exact call text | `worktree.rs::add_and_remove_refuse_native_store_locations_with_the_real_check`, `discard.rs::discard_refuses_a_hard_link_to_a_native_store_with_the_real_check`, `commands.rs::every_work_tree_changing_command_passes_the_native_store_guard` | 843ce94, 8da23a3 |
| D-13-R1 | `GitChangedFile.unreadable` (serialized as `unreadable`) is set for names that were not UTF-8; `git_entry_name` refuses any entry containing U+FFFD, so stage, unstage, discard, diff and open cannot act on a different file. A file genuinely named with U+FFFD cannot be handled in the panel (terminal only). Disabling the actions in the panel and adding the field to the TypeScript type belong to the frontend batch | `parser.rs::one_invalid_utf8_name_is_marked_and_the_rest_of_the_status_is_kept`, `utils.rs::a_name_shown_with_replacement_characters_names_no_entry` | 0776b65 |
| O-04-R1 | Under `cfg(test)`, `build_git_command` points `HOME`, `USERPROFILE` and `XDG_CONFIG_HOME` of every production Git launch at an empty temp dir, and test setup uses `process::test_git()` (same isolation) instead of `Command::new("git")` in all git unit-test modules | `process.rs::unit_tests_never_read_the_developers_global_git_configuration` | 65dcda3 |
| S-02-R1 | `OwnedRepository::content_roots` (worktree, its Git directory, the shared one and, for a linked worktree, the main checkout) is what makes a config origin repository scope | `git_executable_refusal.rs::include_from_the_main_checkout_is_repository_scope_in_a_linked_worktree` | 6771f39 |
| S-11-R1 | A failed lookup is not pinned: `pinned_program` returns a name that cannot exist (the launch reports "not installed") and looks again on the next launch; a found binary is never replaced | `process.rs::a_failed_lookup_is_not_pinned_and_a_found_binary_is_never_replaced` | 9b6d35a |
| S-09-R1 | Forced removal maps an acquisition failure of the target (not authorized, broken `.git`) to a message that points to the terminal; refusals keep their own text | `worktree.rs::removal_of_a_worktree_that_cannot_be_acquired_points_to_the_terminal` | ccc1c73 |
| FMT-R1 | `rustfmt` on `operations.rs` and `tests/common/mod.rs` (only the two files I touched that the review named) | n/a | 90744ae |
| S-10-R1 | Prose below | n/a | this commit |

Additional wording for the merger:

- AGENTS.md edit 1 (scrubbed variables), append: "`GIT_SSH_COMMAND` and `GIT_SSH` in Oarlock's own
  environment are no longer honored by Source Control; set `core.sshCommand` or use `~/.ssh/config`."
- AGENTS.md edit 2, append: "Forced worktree removal also requires the target to be authorized with an
  intact `.git`; otherwise it fails with a message to remove the worktree in the terminal."
- AGENTS.md, same bullet: "`StoreDirs`/`refuse_write_in` in `fs/native_store.rs` is the pure native-store
  check; Source Control builds its guard from it (`git/utils.rs::store_guard`)."
- `docs/architecture/security-model.md` edit (section 4, item 1), add: "Users who set `GIT_SSH_COMMAND` or
  `GIT_SSH` in the environment Oarlock starts with must move that to `core.sshCommand` or `~/.ssh/config`
  for Source Control; terminals are unaffected."

Checks after the rework (in `src-tauri`; no `.ts` file changed):

```
cargo clippy --all-targets --locked -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.04s
cargo test --locked -- --test-threads=1
test result: ok. 1615 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 77.44s
(all integration binaries ok: git_entrypoint_guard 32, git_executable_refusal 10, git_operations 61, git_remote_scope 15, git_store_aliases 2, git_fixture_isolation 2, git_ai_diff 8, git_optional_reads 5)
```
