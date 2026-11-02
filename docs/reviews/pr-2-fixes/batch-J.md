# Batch J: Linux staging and copy

Branch `worktree-agent-a30e54752baffb792`, based on `review/codex-fixes` at e7db16e3. Design: `design-J.md`
(with its Revision 1 section).

## 1. Findings closed

| ID | What changed | Fix location | Tests |
| --- | --- | --- | --- |
| D-12 | A Linux save no longer links the candidate into the user's folder. Every mode stages under a private 0700 folder: the Git common directory, else the user cache (created 0700 when missing), and for a folder with no `.git` ancestor only, a 0700 `.oarlock-staging` child that is removed after publishing and left when not empty. The location must be on the destination's mount (`statx` mount id, `st_dev` as the fallback); `EXDEV` from `linkat` or `renameat2` moves to the next location. Cleanup scans only the private folder and examines at most 4,096 entries. | `fs/linux_staging.rs` (`locations`, `open_location`, `cache_location`, `Candidate::publish`, `cleanup_with_cap`) | `non_repository_stages_privately_and_never_in_the_users_directory`, `crash_between_link_and_rename_leaves_nothing_in_the_users_directory`, `cleanup_stops_at_the_entry_cap_without_error`, `a_missing_cache_directory_is_created_private`, `unusable_cache_falls_back_to_a_private_destination_child_removed_after_publish`, `a_non_empty_destination_child_is_left_in_place`, `a_foreign_git_marker_never_gets_a_destination_child_and_refuses_without_a_cache`, `same_mount_is_reflexive_and_distinguishes_volumes` |
| D-12 (found in review) | `security.selinux` and `security.SMACK64*` no longer make every replacing save fail on an LSM host: they are skipped by `capture`, ignored by `verify`, never removed; a save copies the original's label to the staged file or refuses with a reason; a copy lets the kernel label. | `fs/access_control/extended.rs` (`lsm_managed`, `Labels`, `apply_with`) | `lsm_labels_are_classified_and_other_security_names_stay_refused` (classification only; no SELinux host was available) |
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
