# Batch H: O-15, O-09, O-08, O-07 (simplifications)

Branch `worktree-agent-a2ca5ef18c3d83981`, based on `review/codex-fixes` at e7db16e3. Design:
`design-H.md` (with Revision 1, which folds in the design review).

## 1. Findings closed

| ID | What changed | Fix location | Guarantee tests | Commit |
| --- | --- | --- | --- | --- |
| O-15 | `verify_disk` is gone; snapshot reads serve the loaded catalog. A refused publish (changed catalog) drops the cached `Store`, so Retry reloads from disk. | `src-tauri/src/modules/themes.rs` (`settle`, `CONFLICTS`) | `publish_against_a_file_changed_on_disk_still_conflicts`, `a_snapshot_read_does_not_touch_the_disk`, `a_refused_publish_drops_the_cached_store_so_retry_reloads`, `no_op_changes_touch_no_storage_but_real_changes_refuse_damaged_or_missing_storage` | d86dc757 |
| O-09 | Native recovery pins (`fs_recovery_begin/changed/end`, epochs, `Recovery`) removed; Restore/Save As keep the local tracker. | `fs/mutation_events.rs`, `lib.rs`, `editor/lib/recoveryTarget.ts`, `useDocument.ts`, `documentSession.ts` | `documentSession.test.ts`: "recovery observes parent rename before binding..." (new parametrization); `recoveryTarget.test.ts`: "requires coverage and invalidates pending work when coverage is lost" | b95048dc |
| O-08 | Coordinator replaced by `discard-begin` / `discard-end` on `fs:mutation`; three stateless commands (`git_discard_scope`, `git_discard_match`, `git_discard`); sequence fence on editor reads. | `git/discard.rs`, `git/commands.rs`, `fs/mutation_events.rs` (`bracket`, `announce`, `sequence`), `fs/file.rs` (`mutationSequence`), `editor/lib/{discardBridge,remoteDiscard,mutationFence,gitSignals,documentMutations,documentSession}.ts`, `useDocumentMutations.ts` | `remoteDiscard.test.ts` (all), `nativeDiscard.test.ts` (bridge tests), Rust `discard_publishes_begin_before_and_end_after_the_run_even_when_it_fails`, `a_discard_claims_its_roots_so_a_rename_inside_waits`, `discard_refuses_roots_confirmed_against_another_repository`, `directory_and_leaf_aliases_match_native_entry_and_read_target`, `discard_events_keep_the_wire_names_the_pages_listen_for` | 3b448101 |
| O-07 | Quit seal, overlay, watchdog, deferred lifecycle map, per-edit invalidation (`app_quit_changed`) and D-11's toast removed; one verification ticket, flush then synchronous read and answer. | `windows/quit.rs`, `windows.rs`, `app/hooks/{quitApproval,useAppCloseGuard}.ts`, `editor/lib/{documentSession,documentMutations}.ts`; deleted `quitBarrier.ts`, `quitExtension.ts` | `quitApproval.test.ts` (all), `useCloseGuards.races.test.ts`: "closing the window rechecks revisions in the same task as the close", "editing after approval makes the final verification answer no"; Rust `a_failed_verification_requeues_only_that_window_and_exit_needs_every_answer_for_one_ticket`, `a_stale_ticket_cannot_approve_exit` | 88fa5292 |

Fails-without-the-guard proofs run during the work (guard removed, test red, guard restored):
ancestor match in `recoveryTargetsChanged` (parent-rename test); `awaitMutationSequence` returning
null (fence test); removing `discard.begin` and the `roots` feed to `recoveryTargetsChanged`
(remote and recovery tests); dropping the `hasNewEdits` comparison and reading before the flush in
`QuitApproval.verify` (both quit tests). The Rust bracket, claim and roots-mismatch tests were
verified by construction (the guard types are what they exercise); `discard_refuses_roots_...`
fails if `Scope::confirm` is not called.

## 2. Deviations and limits

- Quit (O-07): the answer "no" re-asks that window and the round continues; Cancel in that prompt ends
  it. An edit after a window's verify answer and before exit is the accepted residual (up to the
  slowest other window's flush plus the exit IPC). No input seal exists any more.
- Discard (O-08): a sequence gap that swallowed the `discard-begin` itself stays a Low residual. A
  lost `discard-end` is noticed at the next event, a gap, a reconcile, listener loss or reload; there
  is no deadline. Published roots are canonical, so a pending Restore under `/tmp` is not matched
  against `/private/tmp` (best effort). A window with no live listener (starting up) reads whatever
  is on disk.
- The fence is initialised from `fs_mutation_sequence` after the listener registers; until that call
  answers, reads are not held.
- Recovery (O-09): alias history (symlinked or `/./` spellings, away-and-back renames through another
  alias) is no longer tracked natively.
- Themes (O-15): a no-op change now succeeds against a damaged file.
- `EditorPane` still passes `prepareDiscard` through `useDocument`; it has no consumer left and was
  not removed (outside this batch's scope).

## 3. AGENTS.md edits (not applied here)

New "Review 108" paragraph, superseding these earlier ones:
- Review 56 to 58 (quit): "Quit asks each window in turn; after every approval native sends one
  verification ticket. Each window flushes chat and spaces, then reads its dirty revisions and
  answers in the same task, without sealing input. A changed revision answers no, native asks that
  window again, and the process exits only after every window answered yes to the same ticket (5 s
  deadline per ticket). An edit after a window's answer and before exit is accepted. There is no
  'Finishing quit' overlay, input seal, watchdog, or 'Can't close yet' toast."
- Review 59, 61, 63 (recovery pins): "Pending Restore and Save As are invalidated by every
  Oarlock-originated rename or delete of the destination or an ancestor (local tracker over the
  `fs:mutation` stream) and by lost mutation coverage. The native `fs_recovery_*` handles are
  removed; alias spellings are not tracked."
- Review 61, 63, 64 (Discard): "Discard is `git_discard_scope` (native roots), `git_discard_match`
  (stateless identity matching over those roots) and `git_discard` (re-plans and refuses when its
  roots differ from the confirmed ones, then runs Git between `discard-begin` and `discard-end` on
  `fs:mutation`, with the roots claimed). The originating window stages every mounted document at
  confirmation and replaces only buffers unchanged since; other windows preserve text and move the
  baseline. Editor reads (`fs_read_file` with `versioned`) carry `mutationSequence`; the window holds
  an adoption until its mutation listener has handled that sequence, so a read that saw Git's write
  cannot be adopted before `discard-begin`."
- `theme/` bullet, after "Commits use the shared conditional, metadata-preserving writer": "Reads
  serve the loaded catalog and never re-read the file; a catalog changed outside Oarlock is noticed
  when a change is published, that change is refused and the cached catalog dropped, so Retry reloads
  it."

## 4. docs/architecture edits (not applied here)

- `two-process-model.md` l.66 (`fs:mutation`): append "It also carries `discard-begin` (origin
  window, repository, canonical roots) and `discard-end` for Source Control Discard, and
  `fs_mutation_sequence` returns the stream's current sequence."
- `two-process-model.md`: the Discard command list now reads `git_discard_scope`,
  `git_discard_match`, `git_discard`.

## 5. Checks run

- `bun run check-types`: `$ tsc --noEmit && tsc --noEmit -p scripts/tsconfig.json` (no errors)
- `bun run lint`: `Checked 1414 files in 456ms. No fixes applied.` / `Found 80 warnings.`
- `bun run test` (`vitest run`, whole repo): `Test Files  4 failed | 641 passed (645)` / `Tests  1 failed | 6164 passed | 2 skipped (6167)`. The 4 failures are
  `src/app/dist-budget.test.ts` (shared Lezer highlighter), `packages/codemirror-vim/scrolling.test.js`,
  `packages/codemirror-vim/range.test.js` and `src/modules/editor/lib/vim.test.ts` ("No getDrawSelectionConfig export
  is defined on the @codemirror/view mock"). None of those files or their inputs was touched; the worktree has no
  `node_modules` of its own (symlinked to the main checkout's), which is the likely cause. They were not run on the
  base commit.
- `cargo clippy --all-targets --locked -- -D warnings`: `Finished \`dev\` profile [unoptimized + debuginfo] target(s)` (no warnings)
- `cargo test --locked -- --test-threads=1` (nextest not installed): library `test result: ok. 1662 passed; 0 failed; 4 ignored`, every integration suite ok, 0 failed.
- `bun run size` was not run (no new dependency; the client lost the coordinator, seal and recovery code and gained about 150 lines).

