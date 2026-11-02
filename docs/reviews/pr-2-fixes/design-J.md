# Batch J design: Linux staging (D-12) and Linux metadata-preserving copy (D-20)

Branch from `review/codex-fixes` at e7db16e3. Phase 1 (this document); nothing below is implemented yet.

## 1. Container

Image `oarlock-linux-ci` (linux/arm64 under OrbStack, Rust 1.99.1 from `rust:1`; the repo has no `rust-toolchain.toml` and no
`rust-version`).

```dockerfile
FROM rust:1
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
    acl attr git libssl-dev && rm -rf /var/lib/apt/lists/*
RUN rustup component add clippy
WORKDIR /work
```

Build: `docker build -t oarlock-linux-ci <dir containing the Dockerfile>`. Run (worktree mounted at `/work`, target dir and
registry in named volumes so macOS artifacts are never touched and rebuilds are incremental):

```sh
docker run --rm \
  -v <worktree>:/work \
  -v oarlock-cargo-registry:/usr/local/cargo/registry \
  -v oarlock-linux-target:/cargo-target -e CARGO_TARGET_DIR=/cargo-target \
  -w /work/src-tauri oarlock-linux-ci cargo check --locked --lib
```

Result on the unmodified source: `cargo check --locked --lib` passes in 55 s (cold) with **4 warnings**: `unused import
check_size` (`primary_selection.rs:68`, pre-existing, expected), and three dead-code warnings caused by D-20's missing Linux
arm: `MAX_COPY_SUFFIX`, `copy_name` (`copy.rs`) and `CopyContext::rename_on_conflict` (`copy_owned.rs`). These three go away
when the Linux copy uses them, so the batch should end at 1 warning (the `check_size` one; confirm the second pre-existing
one AGENTS.md mentions after the full `--all-targets` build).

Tests that need real filesystems: `docker run --tmpfs /mnt/a:exec --tmpfs /mnt/b:exec ...` with
`OARLOCK_TEST_PRIMARY_VOLUME=/mnt/a` and `OARLOCK_TEST_SECOND_VOLUME=/mnt/b` (two distinct `dev` ids). tmpfs supports
`user.*` xattrs on kernels >= 6.6 and POSIX ACLs; the xattr test uses `OARLOCK_TEST_XATTR_SOURCE_DIR` for a filesystem that
cannot (tests will say which they skipped). Overlayfs (the container root) supports both ACLs and `user.*`, so the default
`/tmp` is also usable for the metadata tests.

## 2. D-12: Linux save staging is private in every mode

Today `linux_staging::location_with_cache` returns `(destination.try_clone(), hidden = true)` when `common_dir` finds no
`.git` ancestor (`None` arm), so the candidate (already widened to the final mode/ACL by `AccessControl::apply`) is linked as
`.<pid>-<hex>.tmp` in the user's directory before the rename (`Candidate::publish`, replace branch).

### Changes (all in `src-tauri/src/modules/fs/linux_staging.rs`, plus one call site)

1. **Remove hidden mode.** Delete the `hidden` field of `Candidate`, the `hidden` parameter of `name()`, `is_ours()` and
   `cleanup()`, and the `Ok((destination.try_clone()?, true))` arm. `location_with_cache` becomes `-> io::Result<Dir>`:
   - `common_dir` result `Some(Some(common))`: unchanged (private child of the Git common dir, then cache fallback).
   - `Some(None)` (escaping/foreign `.git`) and `None` (no `.git` ancestor): `cache_location(destination, cache)`, which
     already requires a cache dir owned by the user, not group/other writable, on the destination filesystem and outside every
     Git worktree (`private_staging::outside_worktrees`), creates `oarlock-staging` mode 0700 with inherited ACL grants
     removed (`private_child`), and otherwise returns `Unsupported` ("No private same-filesystem staging directory ...").
     That is the refusal: no private location, no save, identical to repository mode.
2. **Publish stage.** `Candidate::publish` links into `self.staging` (always private) and renames to the destination. The
   `EXDEV` re-pick (`fallback_attempted`, `!self.hidden` guards) simplifies to: on `EXDEV`, recompute `cache_location`
   once, as now.
3. **Mode detection.** With hidden mode gone, detection only chooses *which* private location (Git common dir versus cache),
   so a bare dotfiles repository (no `.git` marker at the work tree) is no longer a special case: it takes the cache location
   like any non-repository. No new detection code.
4. **Cleanup cap.** `cleanup(directory)` stops after `MAX_CLEANUP_ENTRIES = 4096` directory entries examined (counted before the
   `is_ours` filter), returning `Ok(())` silently, with one `log::debug!`. It now scans only the private staging directory,
   which holds nothing but our own entries, so the whole-user-directory scan disappears; the cap protects a very large cache
   staging directory.
5. `private_staging.rs` is unchanged (it already forwards to `Candidate`).

Trade-off to confirm: a destination on a filesystem where the user cache dir is on another device (for example a mounted data
volume with no `.git`) now refuses saves with the "No private same-filesystem staging directory" error instead of writing a
hidden sibling. That is the stated policy. If Opus prefers, an additional private-child-of-the-destination location
(`<dest>/.oarlock-staging`, 0700 with ACL privatized, same filesystem by construction) would avoid the refusal; it leaves a
visible directory but never a readable draft. Default: implement as specified (refuse), no sibling directory.

### Tests (linux_staging.rs, run in the container)

- `non_repository_stages_privately_and_never_in_the_user_directory` (replaces `non_repository_uses_hidden_sibling_and_cleans_stale_entries`): after `Candidate::create`,
  write a draft, link it to the private name (the crash window), then assert the destination directory listing contains no
  new entry and the staged entry sits under a 0700 directory outside `root`; then drop the candidate without publishing and
  assert nothing readable by another user remains in the user's directory.
- `crash_between_link_and_rename_leaves_nothing_in_the_users_directory`: simulate with `link_file` + `forget` of the
  `Candidate` (no `Drop`), list the destination (empty), and `stat` the private staging directory (mode 0700, owner us).
- `cleanup_stops_at_the_entry_cap_without_error`: create 4096 + 10 stale matching entries, run `cleanup`, assert `Ok`, and that
  no more than the cap were removed/examined (add a `cleanup_with_cap(dir, cap)` seam used by `cleanup` so the test uses a small cap).
- `no_private_location_refuses_the_save`: `Candidate::create_with_cache(&dir, None)` on a non-repository returns `Unsupported`
  (the existing two-volume test already covers the repository form).
- Existing tests kept and adapted to the removed `hidden` argument: `cleanup_removes_only_old_unlocked_regular_matching_entries`,
  `substituted_symlink_and_fifo_are_not_opened_or_removed`, the repository, cross-volume, symlinked-staging, substituted-entry
  and unsupported-O_TMPFILE tests. The `non_repository` tests that call `Candidate::create(&dir)` must pass a cache dir:
  `create_with_cache(&dir, Some(cache))`, since `dirs::cache_dir()` is the user's real cache.

## 3. D-20: Linux metadata-preserving copy

Frontend: no gate exists. `fs_copy` already returns a per-item `failed` entry with the backend message; `FileExplorer.tsx`,
`clipboardPaste.ts` and `useExplorerFileDrop.ts` only differ on `IS_MAC` for the paste shortcut. Nothing to remove; the
change is backend only.

### New code

`src-tauri/src/modules/fs/linux_copy.rs` (`#[cfg(target_os = "linux")]`, declared in `fs/mod.rs`), functional core plus thin
syscalls. Plus small additions in `linux_staging.rs`, `access_control.rs`, `copy_owned.rs`.

### Copy sequence for one source item (called from `copy_owned::copy_file`, new `#[cfg(target_os = "linux")]` arm)

1. **Open the source without following links**: `linux_copy::open_source(path)` opens `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY|O_CLOEXEC`
   (existing `open_regular`); on `ELOOP` reopen `O_PATH|O_NOFOLLOW` (the link itself). `handle_path` must equal `source` and
   `gates.reaches` it (existing check in `copy_file`, unchanged). Classify by `fstat` on the handle: file, dir or symlink;
   anything else (FIFO, socket, device) is `Unsupported`.
2. **Pre-check** (macOS `check_tree`/`ensure_supported_mode` equivalents, `linux_copy::check_tree`): refuse setuid/setgid
   files and dirs (`mode & 0o6000`) because `fchown` clears them; walk a folder with directory handles (`openat` `O_NOFOLLOW`),
   depth <= 128, refuse unsupported types, and for every nested symlink require `canonicalize(link)` to succeed and to satisfy
   `registry.gates(Origin::App).reaches` (else "A symbolic link in the copied folder escapes authorized folders"). Top-level
   source symlinks are copied as links without the escape check, exactly as macOS does. Reject copying a folder into itself
   (`context.destination.starts_with(source)`).
3. **Private same-filesystem staging**: `linux_staging::copy_area(destination: &Dir) -> io::Result<CopyArea>` reuses
   `location_with_cache` (Git common dir `oarlock-staging`, else the user cache `oarlock-staging`; both 0700, outside
   worktrees, same device, ACL-privatized by `private_child`) and makes a per-operation child
   `copy-<pid>-<hex32>.d` (0700). `CopyArea` holds `flock(LOCK_EX)` on that directory descriptor for its lifetime and removes
   the subtree in `Drop` (`Dir::remove_open_dir_all`, which does not follow links). If no location exists: `Unsupported`
   ("No private same-filesystem staging directory ..."), the refusal.
4. **Stale sweep**: `cleanup` (D-12 cap applies) also removes `copy-*.d` directories older than `MIN_AGE`, owned by us, whose
   directory `flock` is free, so a crashed copy does not leak a partial tree.
5. **Copy into the area under the name `item`** with `linux_copy::copy_into(area_dir, source_handle, kind)`:
   - *Regular file*: `openat(O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0600)`; `AccessControl::prepare_staging` (existing) removes
     inherited grants before content; data via `copy_file_range` in a loop (1 GiB chunks) and, on `EXDEV`/`EINVAL`/`ENOSYS`/`EOPNOTSUPP` at
     the first call, a 128 KiB read/write fallback; cancel-safe (blocking worker, no async). Then step 6 on the handle.
   - *Symlink*: `readlinkat(fd, "")` and `symlinkat(target, area, "item")` (target verbatim, never resolved).
   - *Folder*: `mkdirat("item", 0700)` and entry-by-entry recursion over `openat`ed handles of source and staging directories
     (names from `read_dir` of the handle; each child opened `O_NOFOLLOW`, type taken from `fstat` on the handle, symlink targets
     re-checked as in step 2 at the moment they are copied). The folder's own metadata is applied **last** (after children), so a
     read-only source folder can still be filled; its mtime is set after its children for the same reason.
6. **Metadata for each file and folder** (`linux_copy::apply_metadata(src: &File, dst: &File)`): capture with the existing
   `AccessControl::capture(src)` (POSIX access ACL via `platform::read`, `user.*` xattrs via `Extended::capture`, mode,
   owner/group, change-stamp check; any `security.*`, `trusted.*` or other xattr is refused by `Extended::capture`), then a
   new `AccessControl::apply_for_copy(&self, staged)`: like `apply`, but ownership is best effort (try `fchown(owner, group)`,
   else group only, else keep the copier as owner, as `cp` does for non-root users), `Extended::apply` and `platform::apply`
   as today, mode last, then verify ACL/xattrs/mode (owner/group excluded from the comparison when ownership could not be
   kept). Directories need an `AccessControl` that accepts directories (`capture` currently requires a regular file:
   add `capture_directory` using `platform::read`/`Extended::capture` on a readable directory fd, the same descriptor kind
   `private_child` already opens) and a default ACL (`system.posix_acl_default`) arm: check whether `platform::read/apply`
   on Linux covers the default ACL; if not, folders with a default ACL are refused with the reason (decided during
   implementation, called out in the report). Times: `futimensat` to the source's atime/mtime.
7. **Publish**: for each candidate name (`name`, then `copy_name(name, n, is_dir)` for `n = 1..=MAX_COPY_SUFFIX` when
   `rename_on_conflict`), `context.validate()`, the native-store `guard(&destination.join(&target))`, `area.verify()`
   (identity of the area directory and `item` via `entry_matches`), then `linux_staging::rename_noreplace_at(area_dir, "item",
   destination_dir, target)` = `renameat2(..., RENAME_NOREPLACE)` with directory descriptors (no path re-resolution, unlike the
   macOS `rename_no_replace(&Path, &Path)`). `AlreadyExists` continues or returns, as macOS. `EXDEV` cannot happen (same
   device checked in step 3); if it does it is returned as an error, never a copy fallback.
8. `destination::sync_directory(dir)` (make `pub(super)`) after a successful publish; failure is logged, not reported (D-03 policy).
9. `CopyArea` drops, removing the staging subtree on success (empty) and on every failure path. Return the final name.

### Refusal conditions (each a per-item `failed` message)

setuid/setgid mode; FIFO/socket/device or any other file type; nested symlink that is dangling, cannot be verified, or escapes
authorized folders; folder into itself; depth > 128; a source xattr outside `user.*` (including `security.selinux` on SELinux
hosts; see open question); an ACL or xattr that the staged file's filesystem cannot hold (`ENOTSUP` on apply, "Cannot preserve
...; file not copied"); `Unsupported` when no private same-filesystem staging directory exists (cache on another device and
no common dir); source changed after open (`handle_path` mismatch); destination changed or outside the workspace
(`context.validate`); native-store guard refusal.

### Reuse summary

- `access_control`: `AccessControl::{capture, prepare_staging, apply (new sibling apply_for_copy), verify, privatize_directory}`,
  `platform::{read, apply, privatize}`, `extended::Extended::{capture, apply}` (Linux arm already present).
- `linux_staging.rs`: `location_with_cache`, `cache_location`, `private_child`, `cleanup`, `link_file` and `entry_matches`
  semantics; new `copy_area`, `rename_noreplace_at`.
- `destination.rs`: `sync_directory` only (the `Destination` type is single-file save staging, not needed for copy; the
  `CopyContext` in `copy_owned.rs` is the copy's destination capability, exactly as on macOS).
- `copy_owned.rs`: `copy_file` gains the `cfg(target_os = "linux")` arm; `CopyContext`, `copy_name`, `MAX_COPY_SUFFIX` and
  `rename_on_conflict` become live on Linux (removes three dead-code warnings). `open_regular` unchanged.

### Tests (new `linux_copy_tests.rs` plus edits to `copy_owned_tests.rs`, run in the container)

Metadata tests need `setfacl`/`setfattr` (installed in the image) and skip with a message on a filesystem lacking ACL/xattr
support.

- `linux_file_copy_preserves_mode_acl_xattrs_and_content` (0640, `setfacl -m u:nobody:r`, `user.k=v`, 3 MiB so `copy_file_range` loops).
- `linux_folder_copy_preserves_nested_metadata_and_applies_dir_metadata_last` (read-only source folder with children).
- `linux_copy_falls_back_to_read_write_when_copy_file_range_is_unsupported` (seam: `copy_data(src, dst, force_fallback)`).
- `linux_symlink_is_copied_as_a_link_not_followed` (relative and dangling top-level; target text identical).
- `linux_nested_escaping_symlink_refuses_the_whole_folder` and `linux_nested_dangling_symlink_refuses`; `linux_inside_symlink_is_kept`.
- `linux_existing_destination_is_not_replaced_and_conflict_renames_to_copy_n` (replaces the macOS-only batch test counterpart).
- `linux_copy_stages_on_the_destination_filesystem` (two tmpfs: source on A, destination on B, area under B's cache/common
  dir via `create_with_cache`; assert area `dev` equals destination `dev`, and no staged entry remains).
- `linux_copy_refuses_without_a_private_location` (`cache = None`, non-repo: `Unsupported`, nothing published, nothing left).
- `linux_copy_never_stages_inside_a_git_worktree` (destination in a repo: area is under `.git/oarlock-staging`; `git status` clean mid-copy via the `before_publish` hook).
- `linux_replaced_source_after_open_is_never_copied` (the macOS test, `after_open` swaps in a symlink).
- `linux_setuid_and_special_files_are_refused`.
- `linux_failed_copy_leaves_no_staging_and_the_stale_sweep_removes_a_crashed_area`.
- `copy_owned_tests.rs`: remove `directories_and_links_are_refused_without_partial_copies` and
  `unsupported_platform_does_not_publish_a_file` (they assert the old Linux refusal); generalize the macOS
  `batch_copies_regular_files_without_replacing_conflicts`, `copy_checks_the_actual_chosen_destination_before_publication`
  and the link/escape tests from `cfg(target_os = "macos")` to `cfg(any(target_os = "macos", target_os = "linux"))` where they do not
  use macOS-only helpers; keep `unsupported_platform...` for non-macOS non-Linux targets.

Gates to run at the end: `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` (serial, `--test-threads=1`)
in the container, then the same on macOS to prove no regression (the macOS build compiles the Linux modules out).

## 4. AGENTS.md edits

- "Explorer mutation policy (macOS release)" paragraph: replace "Linux rename, move and delete use the same checks;
  metadata-safe copy remains unavailable there pending validation. Windows remains a later port." with: "Linux rename, move
  and delete use the same checks. Linux copy (`fs/linux_copy.rs`) stages in the same private same-filesystem location as saves
  (Git common directory or cache, never a worktree), copies data with `copy_file_range`, keeps mode, POSIX ACL, `user.*`
  xattrs, times and, where permitted, ownership, publishes with a directory-relative `renameat2(RENAME_NOREPLACE)`, preserves
  links without traversal, refuses nested links that escape authorized folders and refuses where metadata or a private
  location is unavailable. Validated in a Linux container only, not on a desktop. Windows remains a later port."
- `fs::*` bullet: the `fs_copy` sentence already describes the behavior generically; add "(macOS and Linux)" after
  "stages each item".
- Reviews 76 to 78 area and Review 107: in Review 107, delete "D-12 (its module is `cfg(target_os = "linux")` and only the Darwin
  target is installed here) and D-20 (needs a Linux copy implementation)" from the deferred list; add a Batch J paragraph
  naming D-12 (private staging in every mode, cleanup capped at 4,096 entries) and D-20, the container recipe/tag, and
  the remaining limit (Linux desktop and Wayland copy/drop not run).
- Review 76 text "hidden sibling outside repositories" (Linux save description) becomes "private same-filesystem cache location
  outside repositories"; the staging-cleanup sentence gains the 4,096-entry cap.
- `docs/reviews/pr-2-independent-review.md` D-12 and D-20 Status lines and the ledger rows get "fixed in <sha> (batch J); tests ...".

## 5. Open questions for Opus

1. **SELinux/SMACK `security.*` xattrs.** `Extended::capture` refuses any non-`user.*` xattr on Linux, so on SELinux hosts
   (Fedora, RHEL) every file has `security.selinux` and copies (and, today, saves) would be refused. Proposal: leave save
   policy untouched (outside this batch) but for copy skip `security.*` (the LSM labels the new file by policy, as `cp` without
   `--preserve=context`) and still refuse `trusted.*`/other namespaces. Default if no answer: keep the refusal (consistent with saves).
2. **Default ACLs on folders** (see step 6): preserved if `platform` supports `system.posix_acl_default`, else refuse such folders.
3. **Hidden-sibling removal** refuses saves where the cache dir is on another device and there is no `.git`; accept, or add a
   0700 private child of the destination as a last-resort location (see section 2)?
4. **Ownership**: best-effort, owner stays the copier when `fchown` is not permitted (matches `cp`), rather than the macOS
   behavior (`copyfile` also leaves the copier as owner). Confirm.
