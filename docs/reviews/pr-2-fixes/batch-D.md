# Batch D: editor, documents, tabs, spaces, windows, watchers, themes, menu, release

Branch `worktree-agent-aedd11c62df317a36`, based on `review/codex-fixes` at fe147a5.

## 1. Findings closed

| ID | What changed | Fix location | Test | Commit |
| --- | --- | --- | --- | --- |
| D-01 | Deleting a space with a dirty editor or a running shell asks first; the space is removed only after confirmation. | `src/app/hooks/useTabCloseGuards.ts` (`handleDeleteSpace`, `kind: "space"` on the pending bulk close), `src/app/hooks/tabCloseGuards.ts`, `src/app/components/CloseDialogs.tsx`, `src/app/App.tsx` | `useTabCloseGuards.revisions.test.ts`: "deleting a space with a dirty editor asks before it commits", "deleting a space with a running shell asks, and a clean space commits at once" | 1f96a5a |
| D-22 | `fs_watch_add` registers the valid paths and returns `unavailableDirectories` and `unavailableFiles`; only an unusable environment fails the batch. The client marks unavailable entries and neither retries nor toasts them. | `src-tauri/src/modules/fs/watch.rs` (`prepare_dirs`, `prepare_files`, `Unavailable`), `src/modules/explorer/lib/watch.ts` | `watch.rs`: `failed_watch_preparation_names_the_directories_it_could_not_watch`; `watch.test.ts`: "registers the valid paths of a batch and does not retry or announce a missing folder" | 612a69c |
| D-15 | A file deleted with its folder no longer fails the working-diff watch: the missing parent is reported as unavailable, the repository root registers, the pane gets ready and loads the diff. | same native change; `src/modules/editor/lib/watchWorkingDiff.ts` unchanged | `watch.rs`: `a_file_deleted_with_its_folder_is_reported_not_fatal`; `watchWorkingDiff.test.ts`: "watches a deleted file whose folder is gone..." | 96bb200 (native change is in 612a69c) |
| D-16 | The data directory is canonicalized once; an ordinary launch (no journal, nothing to adopt) reads the registry without pinning, so it no longer depends on safe-storage support (Windows has none). Recovery work takes the pinned, strict path. | `src-tauri/src/modules/windows/restore.rs` (`quick_plan`, `run`); `lib.rs` untouched | `restore/tests.rs`: `a_symlinked_data_directory_starts_and_adopts`, `an_ordinary_launch_through_a_symlink_needs_no_pin`, `recovery_work_is_not_a_quick_launch`. The old `a_linked_state_root_cannot_start_restoration` asserted the defect and was removed. | 3787319 |
| D-05 | Reconciliation: per-root budget, ignore files honored, `.git` skipped, the document's former folder walked first, walker errors skipped, an exhausted budget degrades to `path: null`, and a document without a native version is never bound to a rename destination. | `src-tauri/src/modules/fs/reconcile.rs` (`Limits`, `reconcile_within`); `src/app/App.tsx` stops sending `alternatePath` | `reconcile.rs`: `ignored_folders_and_git_internals_are_not_walked`, `each_root_has_its_own_budget_and_exhaustion_leaves_documents_unresolved`, `the_former_folder_is_searched_before_the_roots`, `an_unreadable_folder_does_not_fail_the_batch`, `a_document_without_a_version_keeps_its_path_but_never_adopts_a_destination` | 2f475e1, d75cbff |
| D-08 | Cmd+W on a split pane checks the pane's foreground process and confirms, under the same "don't ask again" setting. | `useTabCloseGuards.ts` (`handleClosePane`), `CloseDialogs.tsx`, `App.tsx` | `useTabCloseGuards.revisions.test.ts`: "closing a split pane asks first when a program runs in it" | 71780e3 |
| D-18 | A dirty draft detached by a delete event no longer also raises "Close anyway?". | `useTabCloseGuards.ts` (`handlePathsDeleted` takes the detached set), `App.tsx` | "a deleted dirty draft the same event detached raises no delete dialog" | 1b3c5c2 |
| D-07 | Single-tab and delete confirmations recheck the close revision; changed text re-prompts. Dialog actions call `preventDefault` so the dialog stays open. | `useTabCloseGuards.ts`, `CloseDialogs.tsx` | "a single-tab confirmation asks again when the buffer changed after the prompt", "a delete confirmation asks again when the draft changed after the prompt" | 2e0543a |
| D-06 | A coordinated discard follows the document across `retarget`; completion is keyed on the pending-discard token, not the epoch. | `src/modules/editor/lib/documentSession.ts` (`release(path, keepDiscards)`, `stageDiscard`) | `documentSession.test.ts`: "a rename during a coordinated discard still reads the discarded baseline" | db303b4 |
| D-03 | The destination folder is synced after the rename (`File::sync_all` is `F_FULLFSYNC` on Apple). A failed sync is logged, not reported as a failed save. | `src-tauri/src/modules/fs/destination.rs` (`publish_then`, `sync_directory`) | `the_folder_is_synced_after_the_rename_and_a_failed_sync_does_not_fail_the_save` | d1de502 |
| D-04 | A committed write whose version cannot be read back returns a placeholder `v2:unavailable:<hash>` version instead of an error, so callers never treat a committed write as "not committed". The placeholder matches no disk state, so the next save asks before it overwrites. | `src-tauri/src/modules/fs/document_save.rs` (`committed_version`) | `a_committed_write_whose_version_cannot_be_read_is_still_a_success` | ef7333f |
| D-10 | Theme file deletion runs before the selection reset; a file failure still resets the selection and rethrows. Background removal runs under the shared lock; the two dead two-step setters are removed. | `src/modules/theme/themeDeletion.ts`, `src/settings/sections/ThemesSection.tsx`, `importPublication.ts`, `src/modules/settings/store.ts` | `themeDeletion.test.ts` (order test), `importPublication.test.ts` ("removal runs under the shared background lock") | b7199b5 |
| D-11 | A close refused by a seal (another window's verification, pending mutations) now shows an info toast. The seal itself is unchanged (O-07 stays deferred). | `src/app/hooks/useAppCloseGuard.ts` (`notifyCloseBlocked`) | `useCloseGuards.races.test.ts`: "a close refused by another window's quit seal says so" | 99550b8 |
| D-21 | A recovery paired with the native tracker survives an unrelated reconcile (native history is authoritative); a failed scrollback save is a warning and no longer fails the layout flush or the close warning. | `src/modules/editor/lib/recoveryTarget.ts`, `src/modules/spaces/lib/useSpacePersistence.ts` | `recoveryTarget.test.ts`: "a recovery with native history survives an unrelated reconcile"; `useSpacePersistence.failure.test.ts`: "a failed scrollback save is a warning, not a failed flush" | 10fde4e |
| O-11 | The rustfmt edition lookup falls back to 2021 (logged) when the workspace root is unreachable or a manifest is unreadable; the edition is an argument of `arguments()`, no index patching. | `src-tauri/src/modules/fs/formatter.rs`, `formatter/rustfmt_edition.rs` (`for_document_or_default`) | `an_unreachable_workspace_or_unreadable_manifest_falls_back_to_the_default_edition`, `the_edition_is_part_of_the_argument_vector` | 0bd3ff6 |
| O-12 | A stored background image is no longer copied over IPC for native inspection on every window start; it is inspected at import only. | `src/modules/theme/bgImageStore.ts` | `bgImageSafety.test.ts`: "hands a saved background back without inspecting it again at startup" | 9d07c3b |
| O-13 | Only an edit to an already drawn diagram is debounced; first draws and theme switches start at once. A drawing that finishes after its view was hidden is still cached. | `src/modules/markdown/mermaidRender.ts` (`diagramRenderDelay`, `settleDiagramRender`), `MermaidDiagram.tsx` | `mermaidRender.test.ts` ("render timing") | 525128f |
| O-03 | The menu is built with the macOS default key equivalents and records them as the carried set, so New Window and Close Tab have keys from the first frame. | `src-tauri/src/modules/app_menu.rs` (`macos_defaults`) | `app_menu.rs`: `the_menu_is_built_with_the_default_keys_before_any_page_sends_bindings`; `menuShortcuts.test.ts`: "matches the table the native menu is first built with" | 079efb4 |
| O-14 | The macOS leg builds without publishing, verifies, then uploads with `gh release upload`; only the non-macOS legs still publish through `tauri-action`. | `.github/workflows/release.yml` | `scripts/releaseWorkflow.test.ts`: "verifies the macOS bundle before anything is uploaded to the release" | 5bfbcc6 |

## 2. Findings left open with reason

None of the assigned findings is left open. Limits inside closed findings:

- O-11: the "non-blocking notice" is a log line (`log::warn!`); no UI toast, since `fs_format_document` returns only the formatted text and a notice needs a new event and listener.
- D-05: with no native version, a rename whose event failed to apply is not followed any more; the tab shows "Document no longer available" instead of binding to the destination unverified.
- O-14: macOS no longer goes through `tauri-action`'s upload, so it would not contribute to `latest.json`. That is dormant while `UPDATES_ENABLED` is false; turning updates on needs the macOS legs to merge their manifest entries again.
- O-12: a background image stored before this change is not re-inspected either; there is no inspected marker in IndexedDB.
- D-04: the `BACKGROUND_NOT_COMMITTED` wrapper in `preferences.rs` is unchanged. With the sync and version failures no longer errors after the commit point, an error from persist means the rename did not happen.
- D-15 reader-before-watch: the diff still starts after the watch settles; it now settles for a deleted folder. A watch that fails for another reason still shows the error with Retry.

## 3. AGENTS.md edits

- Section `### Frontend (src/)` / module bullet **editor/**, after "A Source Control discard reloads the matching open editors even when dirty": add "A discard follows its document through a rename (`retarget` keeps the pending discards, and completion is keyed on the pending token, not the epoch). The document-mutation queue never binds a document without a native version to a rename destination; a document that cannot be found by identity inside its per-root budget (100,000 entries or 5 s per root, ignore files honored, `.git` skipped, its former folder first) is unresolved, not an error."
- Same bullet, after "`fs_save_document` compares that version": add "A save syncs the destination folder after the rename. A committed write whose version cannot be read back returns a `v2:unavailable:` placeholder version rather than an error, so a later save conflicts and asks."
- Section `### Two-process model` bullet **`fs::tree::*` ... `fs::file::*`**, phrase "Watched files need an authorized folder": append "`fs_watch_add` registers every requested path it can and reports the rest as `unavailableDirectories` and `unavailableFiles` with a reason (a deleted folder, an unauthorized one); only an unusable environment fails the call. The client does not retry or announce unavailable paths."
- Same section, bullet **`windows::*`** ("Each window has its own spaces store"): append "Startup restoration resolves a linked data directory once and pins it only when there is recovery work (a journal or a window to adopt); an ordinary launch reads `oarlock-windows.json` without pinning."
- Section `### Frontend (src/)` bullet **tabs/**: add "Deleting a space asks first when a tab has unsaved changes or a pane runs a program (the same dialog as Close Other Tabs); closing a split pane with Cmd+W asks when its program runs. Single-tab and delete confirmations recheck the close revision and ask again for text that changed after the prompt."
- Section `### Frontend (src/)` bullet **markdown/**, phrase "Diagram rendering waits 300 ms after an edit": replace with "A diagram already drawn waits 300 ms after an edit to its source; a first draw or a theme switch starts at once, and a drawing that completes after its view was hidden is still cached."
- Section `### Frontend (src/)` bullet **theme/**: add "A stored background image is inspected at import only, never again at window start. Deleting a custom theme removes its `.oarlock-theme` file before the selection resets."
- Section `### Bundle config` / macOS signing text (or the release paragraph): add "The macOS release leg builds without publishing, verifies the helper and app signatures, then uploads the artifacts to the draft release."
- Section `### Frontend (src/)` bullet **shortcuts/**, phrase "The bridge (`menuBridge.ts`) loads on macOS only": append "The menu is first built with the default key equivalents (`app_menu.rs`, locked against `menuShortcuts.test.ts`), so New Window and Close Tab carry theirs before any page runs."

## 4. docs/architecture edits

- `two-process-model.md`, `fs_watch_add` command reference: the per-path result shape (`unavailableDirectories`, `unavailableFiles`) and "only an unusable environment fails the call".
- `two-process-model.md`, `fs_reconcile_documents`: per-root budget, ignore rules, former folder first, no rename-destination binding without identity, unresolved is `path: null`.
- `two-process-model.md`, startup/windows restoration: canonicalize once, pin only for recovery work.
- `security-model.md`: no change. The restoration pin still applies to every recovery path.

## 5. Checks run

Frontend, from the worktree root:

- `bun run lint`: `Checked 1406 files in 385ms. No fixes applied.` / `Found 80 warnings.` (AGENTS.md records 79 to 81 existing warnings; none is in a file with a new defect, and the count was not compared per file against fe147a5.)
- `bun run check-types`: `$ tsc --noEmit && tsc --noEmit -p scripts/tsconfig.json` (no errors)
- `bun run test`: `Test Files  643 passed (643)` / `Tests  6145 passed | 2 skipped (6147)` (run before the final D-05 cleanup commit; `bun run vitest run src/app src/modules/editor` afterwards: `Tests  739 passed (739)`)

Rust, in `src-tauri`:

- `cargo clippy --all-targets --locked -- -D warnings`: `Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 17.59s`
- `cargo nextest` is not installed; fallback `cargo test --locked -- --test-threads=1`: `test result: ok. 1602 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 91.30s` (library suite) and every integration suite `ok` with 0 failed (25, 2, 8, 1, 32, 8, 1, 2, 61, 5, 15, 2, 2, 7, 15, 10 passed). Run with the real `HOME`: the Git guard suites passed on this machine, so no isolated `HOME` was needed (the sandbox would not allow setting `HOME`).

Size budgets: `src/app/dist-budget.test.ts` ran inside `bun run test` and passed. `bun run size` was not run; no dependency was added and the client changes are small (new close-dialog branches and a few pure helpers), so any move is expected in the low hundreds of gzip bytes.

## 6. Rework after review

Each item is its own commit (`git log --oneline` after 9b3f8de).

- O-14 rework: the upload step no longer passes the `.app` directory to `gh release upload`. A directory ending in `.app` is tarred as `<stem>_<arch>.app.tar.gz` (arch from `matrix.rust-target`), so the two macOS legs cannot clobber each other; other directories are skipped; plain files (the `.dmg`) go up as they are. `scripts/releaseWorkflow.test.ts` now also asserts the directory test, the `tar -czf`, the per-arch name and the `ARCH_TARGET` wiring. Not run against a real runner.
- D-05 rework: roots that are missing, not folders or unauthorized are skipped (`usable_roots`), their documents resolve to `path: null`. Former folders are scanned only for unresolved documents, once each, by walking the owning root with the walk pruned to that folder, so the root's `.gitignore` applies; the root pass skips them. Total time is capped by one shared deadline (5 s); the entry cap stays per walk. Tests: `a_missing_or_unauthorized_root_is_skipped_not_fatal`, `a_former_folder_is_walked_once_and_only_for_unresolved_documents`. Same commit as D-04 rework (the file is shared): `version_identity` returns `None` for the `v2:unavailable:` placeholder, so a file at its own path binds (`the_unavailable_placeholder_matches_the_file_at_its_own_path`).
- D-22 client rework: the dead `unavailable` mark is gone. Unavailable paths are registered under the batch's retry in `failed`, so a health refresh or Retry asks again for exactly those paths, without a toast. The test fails without the client change (it expects the second `fs_watch_add`).
- D-08 rework: the leaf asked about is captured; `disposePane` is `closePaneByLeaf(leafId)`. Test: "confirming a pane close closes the pane that was asked about".
- D-01 rework: `confirmCloseMany` recomputes a space deletion's tabs from the space at confirmation and re-prompts for new hazards. Test: "a tab opened in the space after the delete prompt is rechecked before the space goes". The App wiring itself (`handleDeleteSpace` passing the commit) has no component test; it is exercised only through the hook.
- O-03 rework: `menuShortcuts.test.ts` parses the `json!` table in `app_menu.rs` and compares field by field.
- Size: not moved to a lazy chunk. The reviewer's measured delta for the batch is +1,332 bytes gzip in the eager startup chunk and +1,466 in total client JS; the new branches are small additions to `CloseDialogs.tsx` and `useTabCloseGuards.ts`, which App mounts eagerly. The merger should account for it in `.size-limit.json`.

Follow-ups after acceptance (section 7 below): L-1 to L-4.

Checks after the rework: `bun run lint` `Found 80 warnings.`; `bun run check-types` clean; `bun run test` `Test Files  643 passed (643)` / `Tests  6147 passed | 2 skipped (6149)`; `cargo clippy --all-targets --locked -- -D warnings` `Finished` with no warnings; `cargo test --locked -- --test-threads=1` `test result: ok. 1605 passed; 0 failed; 4 ignored` plus every integration suite ok.

## 7. Follow-ups after acceptance

- L-1: the Intel macOS archive is named `Oarlock_x64.app.tar.gz` (`x86_64` maps to `x64` before naming, as tauri-action does); the workflow test asserts the mapping and runs the `case` for both targets.
- L-2: unavailable watch paths live in a separate `missing` retry set that is asked again on a health refresh but never holds the failure notice; test "a missing folder never keeps another batch's failure notice on screen".
- L-3: the test is renamed to "registers the valid paths of a batch and retries a missing folder on refresh without announcing it".
- L-4 (AGENTS.md, release prose, append to the macOS release sentence from section 3): "The macOS legs upload their own bundles, so turning updater artifacts on (`createUpdaterArtifacts`) needs their `.app.tar.gz` and `.sig` names made per-architecture and their `latest.json` entries merged, or the two legs overwrite each other."
