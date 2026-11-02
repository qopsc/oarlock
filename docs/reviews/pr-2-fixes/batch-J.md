# Batch J: Linux staging and copy

Branch `worktree-agent-a30e54752baffb792`, based on `review/codex-fixes` at e7db16e3. Design: `design-J.md`
(with its Revision 1 section).

## 1. Findings closed

| ID | What changed | Fix location | Tests |
| --- | --- | --- | --- |
| D-12 | A Linux save no longer links the candidate into the user's folder. Every mode stages under a private 0700 folder: the Git common directory, else the user cache (created 0700 when missing), and for a folder with no `.git` ancestor only, a 0700 `.oarlock-staging` child that is removed after publishing and left when not empty. The location must be on the destination's mount (`statx` mount id, `st_dev` as the fallback); `EXDEV` from `linkat` or `renameat2` moves to the next location. Cleanup scans only the private folder and examines at most 4,096 entries. | `fs/linux_staging.rs` (`locations`, `open_location`, `cache_location`, `Candidate::publish`, `cleanup_with_cap`) | `non_repository_stages_privately_and_never_in_the_users_directory`, `crash_between_link_and_rename_leaves_nothing_in_the_users_directory`, `cleanup_stops_at_the_entry_cap_without_error`, `a_missing_cache_directory_is_created_private`, `unusable_cache_falls_back_to_a_private_destination_child_removed_after_publish`, `a_non_empty_destination_child_is_left_in_place`, `a_foreign_git_marker_never_gets_a_destination_child_and_refuses_without_a_cache`, `same_mount_is_reflexive_and_distinguishes_volumes` |
| D-12 (found in review) | `security.selinux` and `security.SMACK64*` no longer make every replacing save fail on an LSM host: they are skipped by `capture`, ignored by `verify`, never removed; a save copies the original's label to the staged file or refuses with a reason; a copy gives the new file the label of its staging location (a rename keeps the label the file was created with; `restorecon` relabels). | `fs/access_control/extended.rs` (`lsm_managed`, `Labels`, `apply_with`) | `lsm_labels_are_classified_and_other_security_names_stay_refused` (classification only; no SELinux host was available) |
| D-20 | Linux Explorer copy, paste and drop copy files, folders and links with mode, POSIX access and default ACLs, `user.*` xattrs, times and permitted ownership, staged privately on the destination's mount and published with `renameat2(RENAME_NOREPLACE)` through directory descriptors. | `fs/linux_copy.rs`, `fs/linux_staging.rs` (`CopyArea`, `remove_tree`, `rename_noreplace_at`), `fs/access_control.rs` (`capture_directory`, `apply_for_copy`, `finalize_for_copy`), `fs/copy_owned.rs` | see section 3 |
| D-20 (macOS too) | A nested relative link is judged where the copy will put it, not only where it is now. | `fs/copy_owned.rs` (`nested_link_allowed`, `lexical_normalize`) | `a_relative_link_is_judged_where_the_copy_will_put_it`, `a_nested_relative_link_that_escapes_only_at_the_destination_refuses_the_folder` |

## 2. Review points and where they landed

1. A read-only folder is renamed while its owner still has rwx, then given its final mode, ACL and times
   (`Deferred`, `finalize_for_copy`); a failure after publication reports "copied, but its permissions could not
   be set". Staged trees are removed by `remove_tree`, which makes each owned folder 0700 first.
2. LSM labels: see D-12 above.
3. Locations and `EXDEV`: see D-12 above. Copies restage in the next location (`CopyArea::next_location`).
4. Group widening: `apply_for_copy` clears the group bits (no ACL) or refuses (ACL) when the group cannot be kept; the
   `fchown` call is a seam (`Sys::chown`, and a parameter of `apply_for_copy`).
5. Tests run as uid 1000 (command in section 4).
6. Nested links: see D-20 (macOS too).
7. Directory metadata: `capture_directory` captures `system.posix_acl_default`; `apply_for_copy` sets or removes it;
   `platform::privatize` also removes a default ACL from a private folder; setgid on a folder is kept when the group is
   kept and dropped otherwise; setuid and setgid files stay refused.
8. `open_entry` classifies through `O_PATH|O_NOFOLLOW` and reopens only regular files and folders via `/proc/self/fd`.
9. `copy_data` ends the kernel loop on 0, then reads until `read` returns 0; times are read before the data.
10. Copies do one `syncfs` on the area before publishing and `sync_directory` after; `apply_for_copy` does no per-file fsync.
11. `noreplace_error` turns `EINVAL` into an `Unsupported` refusal; no code path renames without `RENAME_NOREPLACE`.
12. `fs/mod.rs` gains `mod linux_copy` and `destination.rs` makes `sync_directory` `pub(super)`.

## 3. Tests added (names)

`linux_copy_tests.rs`: `file_copy_keeps_content_mode_acl_xattrs_and_times`,
`folder_copy_keeps_nested_metadata_and_applies_folder_metadata_after_children`,
`a_read_only_top_level_folder_is_copied_without_privileges`,
`a_failed_copy_with_a_read_only_nested_folder_leaves_no_staging`,
`default_acls_on_folders_round_trip_and_none_is_inherited_when_absent`,
`links_are_copied_as_links_and_never_followed`, `a_nested_link_the_caller_refuses_leaves_no_partial_copy`,
`an_existing_destination_is_not_replaced_and_conflicts_get_a_copy_name`,
`special_files_and_privileged_modes_are_refused_without_a_partial_copy`,
`zero_short_and_unsupported_copy_file_range_still_copy_every_byte`,
`a_filesystem_without_noreplace_is_a_refusal_not_a_plain_rename`,
`a_cross_mount_error_restages_in_the_next_location`, `a_missing_cache_and_an_unusable_one_both_still_copy`,
`a_live_copy_area_survives_another_copys_stale_sweep`, `staging_for_a_copy_is_on_the_destination_filesystem`.
`access_control.rs`: `a_group_that_cannot_be_kept_loses_its_bits_when_there_is_no_acl`,
`a_group_that_cannot_be_kept_refuses_an_acl_that_would_widen_access`,
`a_kept_group_keeps_its_bits_and_a_deferred_mode_stays_writable`.
`linux_staging.rs`: the D-12 tests above plus `remove_tree_empties_read_only_nested_folders`,
`stale_copy_areas_are_swept_and_live_ones_are_kept`, `noreplace_publication_keeps_an_existing_entry`.
`copy_owned_tests.rs`: the macOS-only copy tests that use no macOS helper now run on Linux too
(`final_destination_symlink_is_not_overwritten_or_followed`, `folders_are_copied_without_partial_publication`,
`folder_replaced_after_open_cannot_copy_its_new_target`, `folder_with_nested_outside_link_leaves_no_partial_copy`,
`simultaneous_copies_choose_distinct_names`, `guarded_batch_copies_to_authorized_destination`,
`copies_links_as_entries_without_following_targets`, `batch_copies_regular_files_without_replacing_conflicts`,
`copy_checks_the_actual_chosen_destination_before_publication`, `a_replaced_source_link_is_never_copied_from_its_new_entry`,
`refuses_a_copy_whose_privileged_mode_cannot_be_preserved`). The two tests that asserted the old Linux refusal were removed.
`destination.rs`: `staged_contents_never_enter_the_destination_directory` now allows the empty private
`.oarlock-staging` child on Linux and checks that it is gone after the save.

## 4. Container

Image `oarlock-linux-ci` (Dockerfile in `design-J.md` section 1, plus `git`). Unprivileged run, as uid 1000:

```sh
docker run --rm --user 1000:1000 -v <worktree>:/work \
  -v oarlock-cargo-registry:/usr/local/cargo/registry -v oarlock-linux-target:/cargo-target \
  -e CARGO_TARGET_DIR=/cargo-target \
  --tmpfs /mnt/a:rw,exec,mode=1777 --tmpfs /mnt/b:rw,exec,mode=1777 --tmpfs /home/ci:rw,exec,mode=1777 \
  -e HOME=/home/ci -e XDG_CACHE_HOME=/mnt/a/cache \
  -e OARLOCK_TEST_PRIMARY_VOLUME=/mnt/a -e OARLOCK_TEST_SECOND_VOLUME=/mnt/b \
  -w /work/src-tauri oarlock-linux-ci cargo test --locked -- --test-threads=1
```

The volumes were made writable by uid 1000 once with a root `chown -R 1000:1000` of the registry and target volumes.

## 5. Left open

- No SELinux, SMACK, NFS or bind-mount host was available: the label path, `EINVAL` and the mount-id check against a
  real bind mount are covered only by classification tests and injected failures.
- A copy of a sparse file is dense; hard links inside a copied folder become separate files.
- `rustfmt_edition::resolves_package_defaults_and_workspace_inheritance` fails in the container before and after this
  batch (a toolchain edition check, unrelated).
- `cargo clippy` in the container reports the pre-existing `unused import: check_size` (`primary_selection.rs`) and two
  vendored `unnecessary_cast` errors in `vendor/tauri-plugin-*/src/secure_file.rs`; the main crate was linted with
  `-p oarlock --no-deps -A unused-imports`.
- A Linux desktop run of Explorer copy, paste and drop.

## 6. Rework after review

Verdict `rework 1, 2, 3, 4`; all four done.

1. **Nested link through a conflict name (D-20, commit `25d99055`).** `nested_link_allowed` no longer compares the
   normalized target with `item_dest` by name. `stays_inside_item` walks the written target from the link's folder and
   counts depth below the copied item's root: a target that never rises above the root is accepted; anything that does
   (or is not relative-normal) goes through `resolve_existing_prefix` and the registry. Regression:
   `a_relative_link_cannot_reach_through_an_entry_that_forces_a_conflict_name` (`copy_owned_tests.rs`, macOS and Linux):
   `dest/tree` is a link to an unauthorized folder, so `tree` is published as `tree copy`, and `tree/link -> ../tree/x`
   must refuse the folder. It failed before the change and passes after it (macOS; it also runs in the container).
2. **Staging folders on the AI deny-list (D-12, commit `50625412`).** `secretPaths.json` `componentPrefixes` gained
   `.oarlock-staging` and `oarlock-staging`. Rust `internal_staging_is_never_an_ai_content_source` and the TypeScript
   `blocks internal staging contents and placeholders for reads and writes` now include
   `/work/.oarlock-staging/area/content` and `/home/me/.cache/oarlock-staging/area/content`.
3. **Linux clippy (commit `0ba75467`).** `primary_selection.rs` imports only `WriteOrder` in the Linux module;
   `secure_file.rs` (both vendored copies, still byte-identical) puts `#[allow(clippy::unnecessary_cast)]` on the
   `st_dev as u64` comparison, which stays because `dev_t` is `i32` on macOS.
4. **SELinux label (doc only).** Not cheap to fix (needs an `O_TMPFILE` label probe in the destination), so AGENTS.md and
   section 1 now say a copy takes the label of its staging location and `restorecon` relabels.

Checks (worktree head after the commits above plus the docs commit):

- macOS `cargo clippy --all-targets --locked -- -D warnings`: `Finished dev profile` with no warnings.
- macOS `cargo test --locked -- --test-threads=1`: lib `1678 passed; 0 failed; 4 ignored`, every integration binary ok.
- Container (`oarlock-linux-ci`, uid 1000, `--init`, `git archive` tree) `cargo clippy --all-targets --locked -- -D warnings`:
  `Finished dev profile` with no warnings.
- Container `cargo test --locked -j1 --no-fail-fast -- --test-threads=1` (`-j1` because the default run was killed
  by the linker, signal 9): lib `1697 passed; 3 failed; 4 ignored`. The failures are
  `rustfmt_edition::resolves_package_defaults_and_workspace_inheritance` and the two `wsl_supervisor_*` tests, which
  fail at the base too. Integration binaries are ok except `git_status_limits`
  (`status_reports_unrepresentable_filenames_instead_of_an_empty_tree`: the bind-mounted macOS tree does not keep a
  non-UTF-8 name; the test file is untouched by this batch).
- TypeScript `bun run test src/modules/ai/lib/security.test.ts`: 68 passed. Rust `cargo test --locked secret_paths`: 2 passed.

### Rework round 2 (commit `7de5abf6`)

- **`..` after a name.** A relative link target in which a `..` follows a named component is refused
  (`parent_after_name` in `copy_owned.rs`, before the depth rule and the registry fallback), because on POSIX `..`
  after a link follows the link's target. A leading run of `..` is still judged by the depth rule and the registry.
  Regression `a_relative_link_with_dot_dot_after_a_name_is_refused_because_it_may_follow_a_link` (macOS and Linux; the
  reviewer's probe, renamed): fails with the new check removed, passes with it.
- **`git_status_limits`.** The Linux-only test is now
  `status_marks_unrepresentable_filenames_unreadable_and_keeps_the_rest`: status succeeds, exactly the non-UTF-8 entry
  is `unreadable` with label "Unreadable name", and an ordinary entry is intact. It is `cfg(target_os = "linux")`, so
  it is not compiled on macOS; in the container `git_status_limits` reports `3 passed`.
- macOS: clippy `Finished` clean; `cargo test --locked -- --test-threads=1` lib `1679 passed; 0 failed; 4 ignored`,
  all integration binaries ok. Container (fresh `git archive`, uid 1000, `--init`): clippy `Finished` clean;
  `cargo test --locked -j1 --no-fail-fast -- --test-threads=1` lib `1698 passed; 3 failed; 4 ignored` (the same three
  environmental failures), every integration binary ok.

### Final review Lows (fixed)

- **Linux folder sync.** `sync_directory` opens `openat(dir, ".", O_RDONLY|O_DIRECTORY|O_CLOEXEC)` on Linux, because
  cap-std's `O_PATH` handles cannot be fsynced (EBADF). Test `sync_directory_really_syncs_a_pinned_directory_on_linux`
  (real sync, no injected function): fails before, passes after, in the container.
- **Copy walk into its own staging.** `Walk.skip` holds the `(dev, ino)` of the staging location (`CopyArea::location_id`)
  and `stage_folder` skips a directory with that identity. Test
  `copying_a_repository_git_folder_into_itself_never_walks_into_its_own_staging` (`git init`, copy `.git` into `.git`
  with rename on conflict): failed with "Copy folder exceeds maximum depth" before, passes after.
- **Stale `.oarlock-staging`.** `sweep_stale_destination_child` (called from `Candidate` and `CopyArea` creation when
  the chosen location is not the destination child) cleans and removes an existing private `.oarlock-staging`. Test
  `a_stale_destination_child_is_swept_once_the_cache_is_usable`: fails before, passes after.

### Known limitations (not fixed)

- A copied file keeps the SELinux or SMACK label of its staging folder (an `O_TMPFILE` probe in the destination is the
  eventual fix).
- For `$HOME` dotfiles with no `.git` marker the cache and the `.oarlock-staging` fallback sit inside the bare
  repository's work tree: the D-12 dotfiles clause is narrowed, not eliminated.
- Copies to vfat or exfat with fixed `fmask`/`dmask` are expected to refuse files whose mode is not representable
  (inferred, not mounted).
- A new-file save still needs a staging location: a repository with a foreign `.git` and the cache on another mount
  refuses brand-new files, and a cross-mount cache makes each such save create and remove `.oarlock-staging` (watcher
  events).
- A `.oarlock-staging` pre-created by another user in a sticky folder blocks saves there, safely.
- `inherit_directory`, `prepare_inheritance` and `privatize_empty_probe` are dead on Linux.
- `a_cross_mount_error_restages_in_the_next_location` proves a retry, not a different location, and
  `same_mount_is_reflexive_and_distinguishes_volumes` never reaches the `stx_mnt_id` branch.
