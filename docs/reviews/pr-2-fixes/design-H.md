# Batch H design: O-15, O-09, O-08, O-07

Branch `worktree-agent-a2ca5ef18c3d83981`, reset to `review/codex-fixes` at e7db16e3 (the worktree had
been created at 5502f826). Status: PHASE 1, design only. Nothing below is implemented.

Implementation order: O-15, O-09, O-08, O-07, one commit per item, each with its guarantee test, then
lint, types, tests, Clippy and `cargo test --locked -- --test-threads=1` after each.

Each guarantee test is named below. For every one, the proof that it fails without the guard is part of
the commit: remove the guard, run the test, see it fail, restore.

---

## O-15: theme reads stop re-reading the catalog

### Current mechanism
1. `Store` (`src-tauri/src/modules/themes.rs`) caches the loaded `Snapshot`.
2. `Store::verify_disk` (l.402) reads and parses the whole file (up to 50 MiB), validates it and
   compares it with the cache; any difference is an error until restart.
3. It runs in `themes_snapshot` (l.451), in `mutate` (l.414, before `persist`) and in
   `mutate_at_revision` (l.427, when a revision is expected).
4. `persist(path, snapshot, Some(&previous))` already re-reads the file under the document lock,
   refuses when it differs from `previous` ("Theme storage changed before commit") and then calls
   `document_save::write_checked` with the content version, which conflicts on identity or content.

### Replacement
1. Delete `verify_disk` and its three call sites. `themes_snapshot` returns the cached snapshot.
2. `mutate` applies the change, then calls `persist` only when `next != self.snapshot` (as today). A
   no-op change (`Delete` of a missing id, empty `Upsert`) now returns the cached snapshot without
   touching the disk; it used to fail when the file was damaged or missing.
3. The publish check in `persist` is unchanged and is the only disk comparison.

### Deleted (grep: `rg verify_disk src-tauri src` finds only `themes.rs:402,414,427,451`)
- `Store::verify_disk` and its three calls.
- The test `no_op_changes_refuse_damaged_or_missing_storage` asserts the removed behaviour; it is
  rewritten to assert the new one (a no-op succeeds, a real change against a damaged file still fails).

### Guarantee kept / residual
Kept: a write never replaces a catalog that changed since it was loaded (identity and content version
checked at publish, plus the previous-snapshot comparison); a damaged or missing file fails a real
change. Residual accepted: after an external edit, the UI keeps showing the cached catalog and a no-op
succeeds; the first real change reports "Theme storage changed before commit" and the user restarts or
presses Retry. A same-user writer is best effort (approved model).

### Guarantee tests
- `themes.rs`: `publish_against_a_file_changed_on_disk_still_conflicts` (load, rewrite the file
  externally, `mutate(upsert)` is `Err`, memory and the external file untouched). Fails if the check in
  `persist` is removed. The existing `invalid_batch_and_failed_commit_leave_memory_and_disk_unchanged`
  already covers external edit, damage and a missing directory through `mutate` and stays.
- `themes.rs`: `a_snapshot_read_does_not_touch_the_disk` (delete the file after load, the snapshot read
  still returns the cached value). Fails if a disk read is put back on the read path.

### Docs
- AGENTS.md `theme/` bullet, after "Commits use the shared conditional, metadata-preserving writer": add
  "Reads serve the loaded catalog and never re-read the file; a catalog changed outside Oarlock is
  detected when a change is published and refuses it, so Settings shows the error and Retry."
- `docs/architecture/*.md`: no sentence mentions `verify_disk`. No change.

---

## O-09: recovery keeps only the local tracker

### Current mechanism
1. `useDocument.ts` `createDocumentIo.observeRecovery` calls `observeNativeRecoveryTarget`, which pairs
   the local tracker with `fs_recovery_begin` / `fs_recovery_changed` / `fs_recovery_end`.
2. Native `Stream::begin` claims the target, pins its directory (`Destination::pin`) and stores a
   `Recovery` record; `apply_tracked` resolves each mutation's entry identities while they still exist
   (the `resolve()` closure in `transact`) and marks matching recoveries changed; `changed` re-validates
   the pin; `release_window`, `cleanup_invalid` and `epoch` invalidate by window.
3. The local tracker (`recoveryTarget.ts`: `recoveryTargetsChanged`, fed by the ordered mutation
   listener before any deferral) matches by displayed path spelling and invalidates on loss of mutation
   coverage unless `nativeHistory` was set (D-21).
4. `DocumentSession.recover` consults `changed()` after the write and after the confirming read.

### Replacement
1. `useDocument.ts`: `observeRecovery: (path) => observeRecoveryTarget(path, workspaceScopeKey(
   workspaceEnvForPath(path, owner)))`. It is synchronous; the `RecoveryTarget | Promise<RecoveryTarget>`
   type in `DocumentIo` narrows to `RecoveryTarget`.
2. `recoveryTarget.ts`: delete `observeNativeRecoveryTarget` and the `nativeHistory` field. Loss of
   coverage invalidates every pending recovery again (the pre-D-21 rule; D-21 existed only to let the
   native pin outlive a reconcile). `recoveryTargetsChanged` keeps its ancestor match: a mutation of the
   destination or any ancestor invalidates.
3. `mutation_events.rs`: delete the `Recovery` struct, `State.recoveries` and `State.next`, `Stream.1`
   (epoch map), `epoch`, `begin`, `changed`, `end`, `release_window`, `cleanup_invalid`, the `resolve`
   parameter of `apply_tracked` with the `existing`/changed-marking block, the `resolve` closure in
   `transact`, the module-level `release_window` and the three commands. `apply_tracked` becomes claim,
   mutate, publish.
4. `lib.rs`: remove the three `fs_recovery_*` registrations (467-469) and the two
   `fs::mutation_events::release_window(...)` calls (369, 702). Registration lines only, as scoped.
5. `Destination::pin` stays: saves and creates use it, not only recovery.

### Deleted (grep evidence)
`rg "fs_recovery|observeNativeRecoveryTarget|mutation_events::release_window" src src-tauri/src` finds
`useDocument.ts:7,38-41`, `recoveryTarget.ts:56,65`, `recoveryTarget.test.ts:38,60,79`,
`useDocument.workspace.test.ts:65,89` (mocks), `lib.rs:369,467-469,702` and `mutation_events.rs`. No
other users. Native tests removed:
`pending_recovery_owns_its_window_and_rejects_late_registration`,
`native_recovery_tracks_dot_and_symlink_aliases_even_after_move_back`,
`recovery_directory_pin_rejects_parent_replacement_and_alias_retargeting`,
`failed_and_unrelated_mutations_do_not_interrupt_recovery`,
`an_unrelated_mutation_does_not_invalidate_a_recovery_registered_meanwhile`,
`a_recovery_waits_for_a_running_mutation_of_its_target`. The claim and ordering tests stay. Frontend
tests removed or reduced: the three `observeNativeRecoveryTarget` cases in `recoveryTarget.test.ts`,
"a recovery with native history survives an unrelated reconcile" (D-21's), and the `fs_recovery_begin`
mocks in `useDocument.workspace.test.ts` (its two scoping tests stay).

### Guarantee kept / residual
Kept: every Oarlock-originated rename or delete of the destination or an ancestor, in the owning
environment, invalidates a pending Restore or Save As before it can bind; loss of mutation coverage
refuses or invalidates it; the post-write version and identity re-read still gates binding.
Residual accepted: (a) a same-user alias rename (directory symlink, `/./` spelling) or an external
program moving the destination or its parent during the write is not caught by history; the final native
identity and content version check still catches replacement by different bytes or a different file,
not an away-and-back of the same file; (b) displayed-path matching can miss an Oarlock rename expressed
through a different alias of the same folder.

### Guarantee tests
- `documentSession.test.ts`: `renaming the parent folder of a pending Restore invalidates it`
  (parametrize `recovery observes %s` with `parent rename`): `observeRecoveryTarget("/work/dir/a")`, an
  `fs:mutation` `renamed /work/dir -> /work/dir2` delivered through `subscribeDocumentMutations` while
  the write is held; `recover` resolves false, the session is still detached, `saveFailed` is called.
  Fails if the ancestor match in `recoveryTargetsChanged` is removed.
- `recoveryTarget.test.ts`: `losing mutation coverage invalidates a pending recovery` (no
  `nativeHistory` exemption). Fails if the exemption is reintroduced.
- The existing `scopes destination and ancestor changes...` stays.

### Docs
- AGENTS.md: a "Review 108" paragraph: pending Restore and Save As invalidate on every
  Oarlock-originated mutation of the destination or an ancestor (local tracker); the native
  `fs_recovery_*` pins of Reviews 61 and 63 are removed; alias history is not tracked.
- `docs/architecture/two-process-model.md` (l.66, `fs:mutation`): no recovery sentence. No change.
  `security-model.md`: no mention.

---

## O-08: discard coordinator replaced by two stream events

### Current mechanism
1. `discardBridge.ts` registers a per-page token (`git_discard_register`), listens to `git:discard` and
   runs `DiscardCoordinator` (253 lines): `git_discard_begin`, per-window `git_discard_prepared`
   acknowledgements, `git_discard` (waits for all acks), 2 s polling of `git_discard_status`,
   `git_discard_settled`, `git_discard_cancel`, `git_discard_unregister`.
2. `discard.rs` (1,117 lines): `State`, `Round`, `Event`, `Status`, membership, a 5 s preparation
   timeout, page-loading and release hooks, `git_discard_match_documents(id, token, paths)` (identity
   matching bound to a round), plus the real work: `plan`, `Work::execute`, `guard_tree`, `execute`.
3. Document side: `gitSignals.ts` `prepareNativeDiscard` stages every mounted document at confirmation
   (`DocumentSession.stageDiscard`) and selects matches after native matching; non-originating windows
   always stage with `preserve = true`.

### Replacement
Native, `src-tauri/src/modules/git/discard.rs` (about 250 lines plus tests) and
`fs/mutation_events.rs`:
1. `Change` gains `DiscardBegin { id, origin, repo_root, roots }` (`kind: "discard-begin"`) and
   `DiscardEnd { id, ok }` (`kind: "discard-end"`). `roots` are the native-resolved entry names that
   `plan` already computes (`repo.git_path` joined with each entry, canonical via `to_canon`). They
   travel in the existing `fs:mutation` envelope with its `sequence`, so ordering, gap detection and
   per-environment scoping come for free.
2. `mutation_events::bracket(app, workspace, claims, begin, run, end)`: claim the entry paths (so Oarlock
   renames and deletes of those paths wait and mutation events order around the discard), publish
   `DiscardBegin`, run the closure, publish `DiscardEnd { ok }` from a drop guard (so a panic or error
   still ends it), release the claim. The state lock is never held across `run`.
3. Commands, replacing the eight coordinator commands (`git_discard_register`, `_unregister`, `_begin`,
   `_prepared`, `_status`, `_settled`, `_cancel`, `_match_documents`) and the old `git_discard`:
   - `git_discard_scope(repo_root, entries, workspace) -> Vec<String>`: `plan` only (pins and resolves
     the repository, no events); returns `roots`.
   - `git_discard_match(roots, paths, workspace) -> Vec<bool>`: the Review 64 `match_documents`
     function made stateless. Each document path is resolved natively (`authorized_new(parent)` plus
     name for the entry, `authorized_write_target` for the read target); it matches when either lies at
     or under a root; no file contents are read; unauthorized or unsupported-environment paths fail
     closed.
   - `git_discard(repo_root, entries, workspace)` (in `commands.rs`): `plan`, then `bracket(...)` around
     `Work::execute` with the existing store guard.
   The alias guarantee survives because matching still happens in the backend over canonical names; the
   window only passes document paths and the roots native gave it.
4. Frontend, originating window (`discardBridge.ts` reduced to about 40 lines; `discardAcrossWindows`
   keeps its signature, so `ai/lib/native.ts` is untouched):
   a. `const prep = prepareNativeDiscard(workspace, false)`: stage every mounted document at
      confirmation (unchanged semantics: revision capture, watcher adoption suppressed, autosave
      cleared on select).
   b. `roots = await invoke("git_discard_scope", ...)`, then `await prep.ready(paths =>
      invoke("git_discard_match", { roots, paths, workspace }))` selects the matching candidates
      (autosave and formatter cancelled for them) before Git runs.
   c. `await invoke("git_discard", ...)`; success `prep.complete()`, any error `prep.dispose()` (the
      reload keeps all text, only the baseline moves). Only an unchanged confirmation-time buffer is
      replaced.
5. Frontend, every other window: new `src/modules/editor/lib/remoteDiscard.ts` (about 80 lines), called
   synchronously by the ordered listener in `subscribeDocumentMutations` (before the quit deferral, like
   `recoveryTargetsChanged`, so it does not depend on the O-07 removal):
   - `discard-begin` whose `origin` differs from this window's label: `prep = prepareNativeDiscard(
     workspace, true)`, `prep.ready(match with the event's roots)`, keyed by `id`, plus a one-shot 60 s
     deadline (it exists only while a discard is active) that disposes it.
   - `discard-end`: `ok ? prep.complete() : prep.dispose()`; both preserve text (`preserve = true`).
   - Sequence gap, listener loss or disposal: dispose every active remote discard (preserve).
   Documents mounted while a discard is active still join through `registerDiscardDocument`
   (`gitSignals.ts`, unchanged).
6. `gitSignals.ts`: `prepareNativeDiscard(workspace, preserve)` loses the `(id, token, match)`
   parameters; `ready(match)` binds a match function. `prepareFilesDiscard`, `onFilesDiscarded` and
   `listeners` have no caller outside tests and go with their tests.
7. `useEditorFileSync.ts`: drop `useEffect(installDiscardCoordinator, [])`.
8. `lib.rs`: replace the eight `git::discard::git_discard_*` registrations (551-558) by the two new
   commands; drop `git::discard::page_loading` (368) and `git::discard::release_window` (701). The
   `git_discard` registration in `commands.rs` stays, with the new signature.

### Deleted (grep evidence)
`rg "discardCoordinator|DiscardCoordinator|installDiscardCoordinator|git_discard_(register|unregister|begin|prepared|status|settled|cancel|match_documents)|git:discard|page_loading" src src-tauri/src`
finds only: `discardCoordinator.ts(.test)`, `discardBridge.ts(.test)`, `useEditorFileSync.ts:16,72`,
`discard.rs`, `lib.rs:368,551-558,701`. `rg "prepareFilesDiscard|onFilesDiscarded" src` finds only
`gitSignals.ts(.test)`. Removed: the two coordinator files and their tests, the `State`, `Round`,
`Event`, `Status` and `Registration` machinery, the 5 s timeout and the polling, and the Rust tests
`every_window_must_prepare_and_only_the_owner_can_start`,
`reload_or_new_page_cancels_preparation_and_old_acks_cannot_restart_it`,
`running_worker_survives_owner_close_and_new_page_joins`,
`outcome_is_retained_until_every_participant_settles`,
`unavailable_windows_and_overlapping_discards_are_refused`,
`timeout_or_failed_preparation_never_dispatches_git`, `booting_page_keeps_completion_until_it_can_register`,
`closing_an_unregistered_page_releases_its_finished_membership`. The identity tests (l.787 to 890:
directory and leaf aliases, deleted descendants, re-resolution after retarget, WSL) and the
repository and work tests (l.890 onward) are retargeted to the stateless signature and stay.

### Guarantee kept / residual
Kept: a non-originating window never replaces a buffer with Git's content (it preserves, and only moves
the baseline); the originating window replaces only buffers unchanged since confirmation; documents are
matched by native-resolved identity (directory alias, leaf symlink semantics); a failed or lost round
never discards text; state exists only while a discard runs.
Residual accepted: there is no acknowledgement barrier any more. Native emits `discard-begin` before it
starts Git, but a remote window could in principle autosave and see the watcher event for Git's first
write before it handled the begin event (an ordering between two IPC deliveries, normally milliseconds
apart in the right order). A clean buffer in that window would then adopt Git's content and the text
that window saved moments earlier would exist nowhere. Dirty buffers are never adopted (`reload` skips
dirty). A window that loads during a discard reads whatever is on disk. A lost `discard-end` ends at the
next sequence gap, the 60 s deadline or reload.

### Guarantee tests
- `remoteDiscard.test.ts`: `a window that autosaved newer text keeps it when Git rewrites the file` (two
  `DocumentSession`s over one fake disk; B types and saves, begin delivered, disk becomes HEAD, watcher
  `reload()`; B's text is unchanged and its baseline moves; end delivered, still unchanged). Fails if
  `discard-begin` handling is removed (the reload adopts HEAD).
- `remoteDiscard.test.ts`: `a dirty buffer in another window is never adopted`, `a gap or listener loss
  releases a round and keeps the text`, `the deadline releases a round`.
- `nativeDiscard.test.ts` (rewritten onto the new bridge): `an editor opened through a directory alias is
  matched` (real temporary filesystem; the match function is the same resolution the Rust test locks).
  Fails if matching falls back to path-spelling comparison.
- `nativeDiscard.test.ts`: `the originating window replaces only unchanged buffers` (an unchanged
  matching buffer becomes HEAD; one typed after confirmation keeps its text and gets the new baseline; an
  unmatched buffer is untouched).
- `discard.rs`: `directory_and_leaf_aliases_match_native_entry_and_read_target` (retargeted) is the alias
  guarantee on the native side.
- `mutation_events.rs`: `discard_publishes_begin_before_and_end_after_the_run_even_when_it_fails` and
  `a_discard_claims_its_roots_so_a_rename_inside_waits`. Fail if the drop guard or the claim is removed.
- `documentMutations.test.ts`: `discard events are routed before deferral and never reach tab planning`.

### Docs
- AGENTS.md, new "Review 108" paragraph superseding the Review 63 and 64 description: Discard is three
  stateless commands (`git_discard_scope`, `git_discard_match`, `git_discard`) and two events
  (`discard-begin`, `discard-end`) on `fs:mutation`; no registration, acknowledgement or polling; the
  accepted residual above. The Two-process-model `git::commands::*` bullet already lists `git_discard`;
  no change.
- `docs/architecture/two-process-model.md` l.66: append that `fs:mutation` also carries `discard-begin`
  and `discard-end` for Source Control Discard.

---

## O-07: verify round instead of the quit seal

### Current mechanism
1. After every window approves, `QuitRound::next` sends a `Verify` request (ticket) to all. Each page's
   `QuitApproval.verify` seals the editors (`quitBarrier.ts`: inert `#root`, "Finishing quit" overlay,
   the CodeMirror filter `quitExtension`, a deferred lifecycle map, `beginDocumentMutation` gating),
   flushes state, re-reads revisions and answers; a 6 s watchdog and a 5 s native deadline release it.
2. A subscription (`subscribeDocumentRevision`) reports each edit after approval (`app_quit_changed`); a
   mutation batch cancels an active seal; `closeWindow` seals around `getCurrentWindow().close()` and
   refuses with a toast (D-11) when another seal is active.

### Replacement
1. `quit.rs`: `Verification` keeps `ticket` and `waiting`. `invalidate` no longer emits
   `Resume(.., Some(ticket))`; it removes the window's approval, drops the verification, queues that
   window again and calls `next()` (which asks it and later re-verifies with a new ticket). Remove
   `Action::Resume(_, Some(_))` and `QuitRound::changed`; `Resume(round, None)` stays for cancellation.
2. `windows.rs`: remove `app_quit_changed`; drop `QuitResume.ticket`; the 5 s native deadline in
   `dispatch_quit_locked` stays (it now guards a page that never answers, not a seal). `lib.rs`: remove
   the `windows::app_quit_changed` registration (652).
3. `quitApproval.ts` (about 90 lines): `approve` stores the revision snapshot and sends the yes answer;
   no per-edit subscription. `verify(request)`: if not current, return; `await host.flush()` (false:
   abort); then synchronously `unchanged = !hasNewEdits(host.read(), approved)` and
   `host.answer(request, unchanged)` in the same task, with no await between the read and the call. A
   false answer makes native re-prompt that window. No seal, no overlay, no timer except the abort retry
   for a failed cancel IPC.
4. `useAppCloseGuard.ts`: delete the `sealEditors`, `releaseEditors` and `editorQuitSealed` use,
   `notifyCloseBlocked` (D-11's toast) and the `QuitApproval` `changed` host call. `closeWindow` becomes:
   synchronously `if (hasNewEdits(dirtyRevisions(), approved)) re-ask; else forceClose = true; await
   close()`. `finish` already reads revisions after its flush; the change is dropping the seal around the
   close call.
5. Editor side: delete `quitBarrier.ts` and `quitExtension.ts` (with tests) and the
   `editorQuitExtension` registration in `EditorPane.tsx:5`. In `documentSession.ts` remove the
   `editorQuitSealed()` checks (recover, formatter), the `deferEditorLifecycle` wrappers (open, close,
   openAnyway, detach, adopt, and the `restoreView` branch in `change`), `beginDocumentMutation` in the
   discard finish, and `documentRevisionChanged` (no subscriber remains; `closeRevision()` stays for
   D-07). In `documentMutations.ts` remove `beginDocumentMutation` and `mutation.ready/release`: events
   apply synchronously in order; the reconcile queue and `recoveryMutationCoverage` handling stay.
6. Flush policy (for review): the state flush stays before the yes answer (`finish`) and also before the
   verify read, with the read and answer following the flush in one task, so a window's exposure after it
   answered is the time until the slowest other window answers plus the exit IPC. Alternative A (smaller
   residual): verify does no flush, only read and answer, relying on the stores' own durable saves for
   chat and spaces after approval. Recommended: keep the flush (state loss is worse than a few hundred
   milliseconds of exposure) unless the reviewer prefers A.

### Deleted (grep evidence)
`rg "quitBarrier|editorQuitSealed|sealEditors|releaseEditors|beginDocumentMutation|deferEditorLifecycle|subscribeDocumentRevision|documentRevisionChanged|editorMutationsPending|quitExtension|app_quit_changed" src src-tauri/src`
finds only: `quitBarrier.ts`, `quitExtension.ts(.test)`, `quitApproval.ts(.test)`,
`useAppCloseGuard.ts`, `useCloseGuards.races.test.ts`, `documentSession.ts(.test)`,
`documentMutations.ts(.test)`, `EditorPane.tsx:5`, `windows.rs:734`, `lib.rs:652`, `quit.rs`. No other
users. Tests removed or rewritten: `quitExtension.test.ts` (deleted), the seal cases in
`quitApproval.test.ts`, `documentMutations.test.ts` (l.280-440), `documentSession.test.ts` (l.923-935,
1056-1069, 1117-1121, 1368-1381) and `useCloseGuards.races.test.ts` (l.116, 174-184, 402-430), including
D-11's "a close refused by another window's quit seal says so"; the Rust test
`stale_verification_releases_all_seals_and_requires_confirmation_again` becomes
`a_stale_verification_requeues_only_that_window`.

### Guarantee kept / residual
Kept: the quit exits only after every window answered the same ticket with revisions equal to its
approval snapshot, read after its flush; an edit that lands after a window's approval and before the
final verify makes that window answer no, native re-prompts that window and verifies again with a new
ticket (a Cancel in the prompt cancels the round); closing one window rechecks the same way.
Residual accepted: an edit that lands after a window's verify answer and before `app.exit` (the slowest
window's answer plus the exit IPC, normally milliseconds, up to the flush time of the slowest other
window) is not caught. There is no input seal, overlay or "Finishing quit" state, and a mutation batch
no longer cancels the quit. For a window close, an edit between the final read and the close IPC is lost
to the same degree. Unsaved text still triggers the normal prompt first.

### Guarantee tests
- `quitApproval.test.ts`: `an edit after approval and before the final verify answers no` (approve with
  revision r1, `host.read` returns r2, `verify` sends `answer(request, false)`, `#root.inert` is false
  and no overlay element exists). Fails if the `hasNewEdits` comparison in `verify` is removed.
- `quitApproval.test.ts`: `an edit after the verify answer is the accepted residual` (the yes answer is
  sent; a later revision change sends nothing and does not throw). Documents the limit.
- `quitApproval.test.ts`: `verification never blocks input` (no `inert`, no `role=status` node).
- `quit.rs`: `a_failed_verification_requeues_only_that_window_and_exit_needs_every_answer_for_one_ticket`
  and `a_stale_ticket_cannot_approve_exit`.
- `useCloseGuards.races.test.ts`: `closing the window rechecks revisions in the same task as the close`
  (an edit between confirm and close: no `close` call, a new prompt). Fails if the recheck is removed.

### Docs
- AGENTS.md, "Review 108" paragraph superseding Reviews 56 to 58: quit is ask, approve, one
  verification ticket, each window re-reads its dirty revisions after its state flush and answers at
  once, exit only after all answered, no seal, overlay or watchdog, the residual above; D-11's "Can't
  close yet" toast is gone. The `windows::*` bullet of the Two-process model mentions no seal; no edit.
- `docs/architecture/two-process-model.md`: no quit paragraph exists today; no edit.

---

## Items for the reviewer to confirm
1. O-07 reading of "any changed revision cancels the quit and re-prompts that window": implemented as
   cancel that verification and re-ask that window (the round continues, a Cancel there ends it), as
   today.
2. O-07 flush before the verify read (recommended) versus none (alternative A).
3. O-08 uses three stateless commands (`git_discard_scope`, `git_discard_match`, `git_discard`) and a
   60 s deadline for remote rounds. The task list deletes `git_discard_match_documents`; its logic is
   kept as `git_discard_match` so alias matching survives.
4. O-15: a no-op theme change now succeeds against a damaged file (it failed before).
5. Files outside the stated ownership that must change: `src-tauri/src/modules/windows.rs` and
   `windows/quit.rs` (the quit state machine, required by O-07) and
   `src-tauri/src/modules/git/commands.rs` (the `git_discard` signature). `EditorPane.tsx` is inside
   `editor/**`; `src/modules/ai/lib/native.ts` is untouched.

---

## Revision 1 (review of this design; supersedes the sections above where they differ)

Decisions: O-07 keeps "cancel that verification and re-ask that window"; verify flushes, then reads
revisions synchronously, then answers, in one task. `git_discard_match` stays stateless. Ownership
also covers `windows.rs`, `windows/quit.rs`, `git/commands.rs`, `fs/file.rs` (`fs_read_file` only)
and `editor/lib/useDocument.ts`.

1. O-08 sequence fence (replaces the "ordering between two IPC deliveries" residual). The editor's
   versioned `fs_read_file` returns `mutationSequence`, the mutation stream's sequence sampled under
   the stream state lock after the bytes were read. `DiscardBegin` is published under that same lock
   before Git starts, so a read that saw Git's content carries a sequence at or above the begin
   event's. `subscribeDocumentMutations` exposes the highest sequence its listen callback received
   (`mutationFence`). `DocumentSession.reload` holds a non-discard adoption whose `mutationSequence`
   is above the fence until the listener reaches it, then re-evaluates with the existing epoch,
   generation and `pendingDiscards` checks (begin has staged the document by then, so the read is
   suppressed; if end already ran, its forced reload bumped `readGeneration` and the held result is
   dropped). When the listener is down or not yet live the fence is initialised from the native
   sequence (`fs_mutation_sequence`, one cheap command, called when the listener goes live and on
   reconcile) so nothing waits forever. A sequence gap that swallowed the begin event itself stays a
   documented Low residual. Cost: one lock read per editor read and a u64 in the reply. Test:
   `a read observing a newer mutation sequence is not adopted before the begin event`.
2. O-08 `git_discard` takes the `roots` that `git_discard_scope` returned and refuses, publishing no
   events, when its own `plan` yields different roots. Rust test retargets the alias between the two.
3. O-08 and O-09 listener: the callback branches on kind. `discard-begin` feeds its `roots` to
   `recoveryTargetsChanged` (a pending Restore or Save As whose destination Git rewrites is
   invalidated); `discard-end` feeds nothing; `planDocumentMutation` and the reconcile `failedEvent`
   path ignore discard kinds. Published roots are canonical (`repo.git_path` based), so local
   matching misses a spelling such as `/tmp` against `/private/tmp`: best effort, accepted.
4. O-08 the 60 s remote deadline is dropped. A remote round is released only by `discard-end`, a
   sequence gap, a reconcile, listener loss or reload.
5. O-07 test: the flush promise is held, the revision changes while it is pending, then it resolves;
   `answer(request, false)` is asserted. It fails if the read moves before the await.
6. O-15: on a publish conflict the cached `Store` is dropped (`None`), so Retry reloads from disk.
   Docs say a changed catalog is noticed when a change is published, the change is refused, and Retry
   reloads the catalog.
7. O-08 `nativeDiscard.test.ts` asserts the bridge sends raw document paths plus the native roots and
   compares no spellings itself; the Rust alias test is the alias guarantee.
8. O-08 a rejected or malformed `git_discard_match` for a remote round is caught and disposes the round
   with preserve.
