# Batch I: O-10 (one run owner, revision-keyed credentials, durable chat metadata)

Branch `worktree-agent-ad0b007dfd04e1f35`, from `review/codex-fixes` at e7db16e3. Design: `design-I.md` (with its section 6, the review revisions).

## 1. Finding closed

| Part | Fix | Tests | Commit |
| --- | --- | --- | --- |
| 3 | `ai_sessions_mutate` saves through `store.save()` (inside `fs::blocking`) before it emits; the gate (`sessionsGate`: revision, evicted-through, at most 256 tombstones) persists; a delta carries `base`, fixed at enqueue | `ai_metadata.rs`: `a_mutation_is_on_disk_before_the_command_succeeds`, `a_failed_save_changes_nothing_and_publishes_nothing`, `a_deletion_from_another_window_is_not_resurrected_after_restart`, `the_tombstone_set_never_exceeds_its_bound`, `a_creation_older_than_the_oldest_kept_tombstone_is_refused_by_revision`, `a_retried_creation_keeps_the_base_it_was_enqueued_with`, `a_creation_at_revision_zero_is_kept`, `legacy_string_tombstones_load_and_are_rewritten`, `revision_survives_a_restart_and_a_damaged_gate_is_an_error`, `the_plugin_doc_store_saves_before_returning` (a source guard); `sessions.persistence.test.ts` "keeps the base revision a create was enqueued with through a retry" | ed6f222a |
| 2 | Accounts are `<account>@r<secretsRevision>`; no random namespace; pre-clean at the new revision; created servers start at revision 1 | `credentials.rs`: `a_failed_keychain_write_leaves_the_previous_secrets_and_configuration_usable`, `a_stale_editor_cannot_overwrite_a_newer_transport_or_secret`, `an_http_session_checks_its_revision_before_reading_tokens` (source order guard), `creating_a_server_with_a_secret_keeps_it_after_commit`, `a_leftover_from_a_crashed_stage_cannot_become_active`, `a_failed_preclean_stops_the_save_before_any_staging`, `a_legacy_credential_version_is_read_until_the_next_save_then_dropped`, `revision_accounts_cannot_alias_legacy_hex_or_chunk_suffixes` | 61d14e5d |
| 1 native | `mcp/runs.rs`: `ai_run_begin` (inserted under the Stop barrier's lock via `ai_chat_control::admit_register`), `ai_run_mcp_open`, `ai_run_end`; `revoke_chat` in `stop`'s injectable `run_cleanup` | `leases.rs`: `page_reload_revokes_records_and_pending_starts`, `stop_revokes_every_record_of_the_chat_in_every_window_and_leaves_other_chats`, `a_foreign_window_cannot_end_or_open_another_windows_run`, `run_capacity_is_per_window_and_counts_runs_without_projects`; `ai_chat_control.rs`: `stop_revokes_run_records_even_when_an_emission_failed_and_before_anything_waits`, `stop_passes_the_real_revocation_to_its_cleanup_sequence` (source guard), `ai_run_begin_is_refused_while_the_chat_is_stopping`; `runs.rs`: `run_ids_are_32_lowercase_hex_characters` | f2347e8c |
| 1 page, deletions | `ai/lib/runOwner.ts` replaces `chatWork`, `mcpRunLeases`, `ownedStream` and the composer-work registry; `mcp_run_open` and `mcp_run_release` and the old lease ids are gone | `runOwner.test.ts` (12 cases: Stop releases stream, record and preparation; failed release retried; Stop waits for work; accept drops watchers and a later navigation cannot cancel the turn; claim by user-message id; a stopped owner is not replaced; abandon; navigation cancels only preparation; pause and continuation; error after approval; SDK abort; refused admission), `chatDeletion.test.ts` (local and remote deletion), `transport.test.ts` (rewritten lease cases, including the Review 52 order `ai_run_begin(new)` before `ai_run_end(old)`), `runServers.test.ts` | 0e972251 |

The page migration and the deletions are one commit (not two): `transport.ts` needs the new owner and the old modules go with their last caller, so a split commit would not type-check.

Mutation checks (delete the release, watch the test fail), all caught: the stream cancel adoption, the `ai_run_end` adoption (18 failures), `closeChatRuns` in `stopLocal`, `runPrepared()` in `accept`, and the `previous.close("continued")` in the transport.

## 2. Decisions applied from the design review

H1 `evicted_through` is an option and the stale rule is strict; H2 created servers start at revision 1; M1 `accept` drops the preparation watchers once, `claimRun` matches the submitted user-message id, a stopped accepted owner is not replaced; M2 insert under `ChatControl` (order ChatControl then leases), `ai_run_mcp_open` fails for an ended run, `revoke_chat` runs unconditionally before the emission-error return and emits `mcp:run-leases-changed` when it removed a project; M3 `run_cleanup` with a fake plus a named source guard; M4 `base` fixed at enqueue; L1 to L11 as listed in `design-I.md` section 6; L7 pre-release servers saved between the two credential schemes fail with the missing-secret error and the user re-enters the secret (also in AGENTS.md); L10 records live in `mcp/runs.rs`.

## 3. Left open or limited

- Windows and Linux were not run.
- A deletion written by an older native (`deletedSessions` strings) is read as revision-0 tombstones; after the first save the key is removed, so a build older than this one then sees no tombstones (it does not fail closed, which section 4 of the design claimed).
- Page-only `prepare` and `work` owners die with the page and have no native record; an OS call already started (keychain read, MCP spawn) is not interrupted.
- `ai_run_mcp_open` is hard-failing for a begun-then-ended run; a failure to open a project still costs the run its project servers only (it logs and goes on), as before.
- The metadata save is fsync, not `F_FULLFSYNC`; power loss is not covered.
- A create enqueued before the first snapshot has `base` 0 and is dropped silently once a tombstone with a revision above 0 has been evicted; the page then sees its chat missing from the next snapshot.
- Only `stop` and `deleted` record an accepted message as stopped; an abandoned owner (a failure before the transport claimed it) does not block Retry or regenerate of that message.

## 4. Verification (this worktree)

After a real `bun install --frozen-lockfile` (the first run used a symlinked `node_modules`, which produced the vim-package, `dist-budget` and 81st lint warning artifacts):
- `bun run check-types`: clean. `bun run lint`: 80 warnings, no errors. `bun run test`: 646 files, 6213 passed, 2 skipped (my re-run after the rework). `check:dist`: clean.
- Size (reviewer's run): total 2,901,969 vs base 2,900,924 (+1,045); startup 258,167 (-13); terminal, WebGL and WASM unchanged. The base is already over two budgets on this machine.
- `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`: clean. `cargo test --locked -- --test-threads=1`: lib 1695 passed, 0 failed, 4 ignored; all integration targets passed.
