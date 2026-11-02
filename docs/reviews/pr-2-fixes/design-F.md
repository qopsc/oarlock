# Batch F design: O-01, delete the isolated-executor pieces

Phase 1 only. Nothing below is implemented yet. Base `e7db16e3` (the worktree started on `5502f826` and was
reset to it as instructed).

Decision recorded by the owner: delete the pieces of the isolated executor that have no production caller.
Keep `parse_config`, which `commit_guard.rs` uses.

## 1. Inventory of what is removed, with the evidence it has no other user

### Rust modules (`src-tauri/src/modules/git/`)

| File | Lines | Evidence of no other user |
| --- | --- | --- |
| `candidate_index.rs` | 400 | Referenced only by `mod.rs:3`, by `index_publication.rs` tests (`use ...candidate_index::{self, EntryValue}`, line 296) and by `tests/git_candidate_object.rs`. No other `candidate_index::` path in `src` or `tests`. |
| `index_publication.rs` | 801 | Referenced only by `mod.rs:11`. No `index_publication::` path anywhere else. |
| `candidate_object.rs` | 161 | Referenced only by `mod.rs:4` and `tests/git_candidate_object.rs`. |
| `worker.rs` | 112 | Referenced only by `mod.rs:20` and `lib.rs:575` (`git::worker::git_execution_capability`). The frontend never invokes it: `grep -rn "git_execution_capability\|gitExecution" src` is empty. |

`mod.rs` loses `pub mod candidate_index; pub mod candidate_object; pub mod index_publication; pub mod worker;`.

### `candidate_policy.rs` (270 lines): trimmed, not deleted

Only `parse_config` is used outside the file (`commit_guard.rs:4,141,248`). `CandidateConfig` and its `capture` and
`values` have no user outside the file's own tests (`grep -rn "CandidateConfig" src-tauri/src` hits only
`candidate_policy.rs`). `Refusal` is the error type of `parse_config`; `commit_guard` maps it away with
`map_err(|_| ...)`, so the type stays, but its variants `ExecutableExtension` and `UnsupportedConfiguration` are only
built by `CandidateConfig::capture` and go. Details in section 2.

### Integration test

`src-tauri/tests/git_candidate_object.rs` (one test, imports `candidate_index` and `candidate_object`). Removed.
The `tests/common/mod.rs` helpers it uses (`git_available`, `GitRepoFixture`) are used by the other Git integration
tests, so `common` is untouched.

### Objective-C XPC helper and client

- `src-tauri/git-worker/` (whole folder: `README.md`, `apple_git.{h,m}`, `client.{h,m}`, `entitlements.plist`,
  `protocol.{c,h}`, `service.m`, `signature.h`, `smoke.m`). Referenced by `build.rs`, `tauri.conf.json`,
  `scripts/git-worker/*`, `worker.rs` (the `oarlock_git_worker_probe` extern), `README.md:165` and docs.
- `scripts/git-worker/` (`build.mjs`, `smoke.mjs`, `verify-app.mjs`).
- `scripts/lib/gitWorkerSigning.test.js` (imports `signingPolicy` from `scripts/git-worker/build.mjs`; also asserts
  that `release.yml` contains `OARLOCK_DISTRIBUTION_BUILD`).
- Search for other users of the folder names (a recursive grep for `git-worker`, `git_execution_capability` and `XPC`)
  lists, outside history files, only the files named in this document. `scripts/renderer-profile/procstats.test.ts:57`
  mentions `XPCServices/com.apple.WebKit.WebContent`, unrelated (a WebKit process path in a fixture); untouched.

### Config keys

- `src-tauri/tauri.conf.json` line 10: `build.beforeBundleCommand` (`bun scripts/git-worker/build.mjs`). Removed; it is the
  only `beforeBundleCommand`.
- `src-tauri/tauri.conf.json` lines 70-72: `bundle.macOS.files` (`XPCServices/OarlockGitWorker.xpc`), the only entry.
  Removed; `macOS.minimumSystemVersion` and `entitlements` stay.
- `src-tauri/build.rs`: `configure_git_client()` and its call (compiles `git-worker/client.m` with `xcrun clang`, `ar`,
  links `Foundation` and `Security`). `configure_sidecar()` and `tauri_build::build()` stay. No `cc` crate is used (it
  shells out to `xcrun`), so there is no build-dependency to remove.
- Environment: `OARLOCK_DISTRIBUTION_BUILD` is read only by `scripts/git-worker/build.mjs` (outside that script it
  appears only at `release.yml:118,183` and in the signing test). Both `env` lines in `release.yml` go.
- `.gitignore:33` `src-tauri/binaries/` stays (the CLI sidecar still lives there).

### Workflow steps

`.github/workflows/ci.yml`: the step "Sandboxed Git XPC bootstrap and rejection paths" (`bun scripts/git-worker/smoke.mjs`,
macOS only), lines 185-187.

`.github/workflows/release.yml`:
- "Import identity for the sandboxed Git helper" (`apple-actions/import-codesign-certs`) and its comment, lines 99-107.
  `tauri-action` imports `APPLE_CERTIFICATE` itself (the env is passed to it at lines 188-193), so the nested-XPC-first
  ordering is no longer a reason for the step.
- `OARLOCK_DISTRIBUTION_BUILD: "1"` at lines 118 and 183.
- "Verify packaged Git helper sandbox and signatures" (`verify-app.mjs`), lines 133-138. See the open question below.
- Comment lines 108-111 mention "packaged helper and app signatures verify"; reworded.

### Dependencies

- `sha1 = "0.10.6"` (`Cargo.toml:93`). Uses: `candidate_index.rs` (4 sites), `index_publication.rs` tests (2),
  `candidate_object.rs` (1). A word-search for `sha1`/`Sha1` in `src-tauri/src` and `src-tauri/tests` finds nothing
  else. Removed. It may stay in `Cargo.lock` as a transitive dependency; Cargo will decide.
- `cap-std` stays: still used by `fs/destination.rs`, `fs/file_identity.rs`, `fs/copy_owned.rs`, `git/ownership.rs` and
  more.
- `sha2` stays (skills, project trust).
- No `cc` or `objc` crate exists; nothing else to remove. After the edit: `cargo build --locked`; if `--locked`
  complains, one plain `cargo build` regenerates the lock and the note says so.

### Documentation

- `README.md:162-167`: the paragraph about the ad-hoc Git helper and `verify-app.mjs`. Replaced by one line saying the
  isolated Git executor and its XPC helper were removed (O-01); release signing is Tauri's.
- `AGENTS.md`: the long Review 69 to 80 history that describes the helper and executor is a log and is not rewritten.
  Add one paragraph under `### Review 107` saying O-01 was resolved by deletion and listing what went. Nothing in the
  architecture sections (above `## Further reading`) describes the executor, so nothing there changes. The historic
  sentences ("The complete isolated execution/publication pipeline remains a release blocker", and so on) get no edit;
  the new paragraph supersedes them.
- `docs/architecture/security-model.md`: no sentence describes the executor (searching it for xpc, isolated, helper and
  sandbox finds nothing about Git). Line 275 ("Native Git refuses configured executables only from repository-origin
  configuration ...") is the live policy and stays; append one sentence: "The isolated candidate executor and its
  sandboxed XPC helper were removed (review O-01); only this preflight guard remains." The other
  `docs/architecture/*.md` files mention nothing.
- `REVIEW_LEDGER.md` and `docs/pr-1-review-coverage.md`: historical records of file reviews; not edited.
- `docs/reviews/pr-2-independent-review.md` O-01: Status line updated to "fixed in <commit> (batch F, deletion); no test
  (code removed); release checks in batch-F.md".

## 2. What stays and why

- `candidate_policy.rs::parse_config` and `Refusal`: `commit_guard.rs` parses `git config --null --list` output through
  it (repository, worktree and included files; lines 141 and 248). Behavior and its tests unchanged.
- Trim: delete `CandidateConfig` (struct, `capture`, `values`), the `BTreeMap` import, and the `Refusal` variants and
  `Display` arms only it produced. `Refusal` keeps `IncompleteConfiguration` with its message. The module doc comment
  (which describes isolated candidates) is rewritten in two lines to say it is the NUL-config parser for the commit
  guard. The tests that exercise `CandidateConfig` go; the `parse_config` tests (NUL records, implicit boolean,
  truncation, limits) stay. The batch note will list which tests survive. I keep the filename: moving it is a rename
  with no gain.
- `ownership.rs`, `process.rs`, `commit_guard.rs`, `remote_guard.rs`, `discard.rs`, `ai_diff.rs`: the live runner. Untouched.
- `src-tauri/binaries/` and the CLI sidecar plumbing in `build.rs`.

## 3. Exact edits

`src-tauri/src/lib.rs`: delete line 575 `git::worker::git_execution_capability,` from `generate_handler!`. Nothing else
names it. `tauri.conf.json` has `removeUnusedCommands: true`; I will confirm no capability or permission file lists the
command (`src-tauri/capabilities`, `src-tauri/permissions`).

`src-tauri/src/modules/git/mod.rs`: remove the four `pub mod` lines named above.

`src-tauri/build.rs`: remove `configure_git_client()` (the whole function) and its first call in `main`, leaving
`configure_sidecar(); tauri_build::build()`.

`src-tauri/tauri.conf.json`: remove `"beforeBundleCommand"` from `build`; remove `"files": {...}` from `bundle.macOS`
(keep the commas valid).

`.github/workflows/ci.yml`: delete the macOS smoke step (3 lines plus blank).

`.github/workflows/release.yml`:
- delete the import-identity step and its comment;
- delete both `OARLOCK_DISTRIBUTION_BUILD: "1"` lines;
- replace the comment above `tauri-mac` ("until the packaged helper and app signatures verify") with "until the packaged
  app signature verifies";
- replace the verify step with one named "Verify the packaged macOS app signature" that runs
  `codesign --verify --deep --strict --verbose=2` on the single `.app` in the bundle directory, with the team-identifier
  requirement the old script applied (`anchor apple generic and certificate leaf[subject.OU] = "$APPLE_TEAM_ID" and
  identifier "consulting.quantumops.oarlock"`), as a few lines of bash inline, using the same env block
  (`APPLE_TEAM_ID`, `OARLOCK_RELEASE_TARGET`). This keeps the "verify before anything is uploaded" ordering that
  `scripts/releaseWorkflow.test.ts` locks, without a script file.

`scripts/releaseWorkflow.test.ts`: `named("verify-app.mjs")` becomes `named("Verify the packaged macOS app signature")`;
every other assertion is unchanged. Delete `scripts/lib/gitWorkerSigning.test.js` (its only subject is gone); its
assertion that `release.yml` contains `OARLOCK_DISTRIBUTION_BUILD` goes with it.

`src-tauri/Cargo.toml`: remove `sha1 = "0.10.6"`. `Cargo.lock`: regenerate by the `cargo build --locked` step above.

Deleted paths: `src-tauri/git-worker/`, `scripts/git-worker/`, `scripts/lib/gitWorkerSigning.test.js`,
`src-tauri/tests/git_candidate_object.rs`, the four modules.

## 4. Checks and doc sentences

Checks, in this order, in `src-tauri` unless noted:
1. `cargo build --locked` after the dependency removal (fall back to plain `cargo build` once and report it).
2. `cargo clippy --all-targets --locked -- -D warnings`.
3. `cargo test --locked` (nextest is not installed). The test count drops by the deleted modules' tests; I will report
   the before and after counts.
4. Repository root: `bun run check-types`; `bun run lint` (no new warnings over the 79 baseline);
   `bun run test -- scripts` (covers `releaseWorkflow.test.ts` after the edit and shows the deleted
   `gitWorkerSigning.test.js` leaves nothing dangling); then the full `bun run test` once.
5. Residual searches that must come back empty outside the history files (`AGENTS.md` review sections, `REVIEW_LEDGER.md`,
   `docs/pr-1-review-coverage.md`, `docs/reviews/`): `git-worker`, `git_execution_capability`, `OarlockGitWorker`,
   `candidate_index`, `index_publication`, `candidate_object`, `CandidateConfig`, `oarlock_git_worker_probe`.
6. No frontend code changes, so `bun run size` and `check:dist` are unaffected and I will not run a build unless asked.
   Only the Darwin target compiles here; the removed XPC code was `cfg(target_os = "macos")` and the rest is
   platform-neutral, and the note will say Windows and Linux were not built.

Sentences to change: add to AGENTS.md `### Review 107` one paragraph: "O-01 is resolved by deletion. The isolated
executor pieces with no production caller (`candidate_index`, `index_publication`, `candidate_object`, `worker` and its
`git_execution_capability` command, the sandboxed XPC helper under `src-tauri/git-worker` and its build, signing,
verification and CI steps, and the `sha1` dependency) were removed; `candidate_policy::parse_config` stays for the
commit guard. Reviews 67 to 80 describe the removed design and are history." In the "Deferred by decision" list of the
same section, drop O-01. In `security-model.md` line 275 append the one sentence in section 1.

## Open question for the owner

The old `verify-app.mjs` also verified the outer app's signature and team requirement, not only the helper. Deleting
the step outright would leave the macOS release with no pre-upload signature check. I propose to keep a short inline
`codesign` verify step (above). If Opus prefers no check, the release test's ordering assertion would instead compare
build and upload only.

## Revisions after design review

1. `RepositoryPin::index_directory` (`ownership.rs:79`) has one caller, `index_publication.rs:123`. It is removed with
   that module (it would otherwise be dead code under `-D warnings`). Its `directory` field stays: `validate` and
   `configure` use it. Everything else `index_publication` imported has other users.
2. `scripts/releaseWorkflow.test.ts` finds the verify step by its command, not only its name, and asserts it runs
   `codesign --verify --deep --strict`, passes a requirement with `anchor apple generic`,
   `certificate leaf[subject.OU]`, `$APPLE_TEAM_ID` and the bundle identifier, is gated on `startsWith(matrix.platform,
   'macos')` and runs under `set -euo pipefail`. The step's bash is also extracted and run against a temporary
   directory with zero and with two `.app` bundles (and a bad team id), expecting a non-zero exit.
3. The step uses `-R="..."` (the leading `=` marks requirement text; `-R "..."` reads a file path), fails on an empty or
   malformed `APPLE_TEAM_ID` (`^[A-Z0-9]{10}$`), requires exactly one `*.app` in
   `src-tauri/target/$OARLOCK_RELEASE_TARGET/release/bundle/macos`, uses `set -euo pipefail` and reads the identifier
   with `jq -r .identifier src-tauri/tauri.conf.json`.
4. `Cargo.lock`: `sha1 0.10.7` has one dependent and no transitive user, so its entry is removed in the same commit as
   the `Cargo.toml` edit (one plain `cargo build` regenerates it; `--locked` would fail). `cpufeatures` and `digest`
   stay. The frozen-lock rule is lifted for this batch only.
5. `ci.yml`: the `oven-sh/setup-bun@v2` step after `cargo nextest` exists only for the smoke step and goes with it.
6. `candidate_policy.rs`: `Refusal` keeps one variant with `Display` and `Error`; the `IncompleteConfiguration` message
   no longer mentions a candidate. The deleted hooks-outside-hooks-directory test stays covered by `commit_guard.rs`.
7. `build.rs`: removing `configure_git_client` also drops the explicit Foundation and Security framework links; the
   Darwin build proves the crates link them themselves. The batch note says so.
