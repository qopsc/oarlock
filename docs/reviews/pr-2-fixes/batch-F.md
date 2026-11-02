# Batch F: remove the unused isolated Git executor (O-01)

Branch `worktree-agent-a68ad99b7c2a3721b`, based on `review/codex-fixes` at e7db16e3 (the worktree was created
from `main` and reset to e7db16e3 first). Design: `design-F.md` (with the review revisions folded in).

## 1. Finding closed

| ID | One line | Fix location | Test | Commit |
| --- | --- | --- | --- | --- |
| O-01 | The executor pieces with no production caller, the sandboxed XPC helper and its release steps are deleted; `parse_config` stays for the commit guard | see section 2 | `scripts/releaseWorkflow.test.ts` (signature step run against temporary bundle directories); the existing `candidate_policy` parser tests and `commit_guard` tests lock what stays | 191f903, 3 following commits |

Commits: 191f903 (Rust, config, helper, scripts), then the workflow and test commit, then the docs commit, plus the
design revision commit before them.

## 2. What went

- `src-tauri/src/modules/git/`: `candidate_index.rs`, `index_publication.rs`, `candidate_object.rs`, `worker.rs`
  (and `git_execution_capability` in `lib.rs`), `RepositoryPin::index_directory` (its only caller was
  `index_publication`; its `directory` field stays for `validate` and `configure`), and the four `pub mod` lines.
- `candidate_policy.rs` is trimmed to `parse_config` plus `Refusal` (one variant, message no longer mentions a
  candidate). `CandidateConfig` and its four tests went; the `parse_config` test stays. The removed
  hooks-outside-the-hooks-directory test is covered by the injected `hook.*` case at the end of `commit_guard.rs`'s tests and by
  `tests/git_executable_refusal.rs::commit_refuses_configured_executable_classes`.
- `src-tauri/tests/git_candidate_object.rs`; `src-tauri/git-worker/` (incl. its README); `scripts/git-worker/`;
  `scripts/lib/gitWorkerSigning.test.js`.
- `src-tauri/build.rs`: `configure_git_client` and its call. `tauri.conf.json`: `build.beforeBundleCommand` and
  `bundle.macOS.files`.
- `Cargo.toml`: `sha1`. `Cargo.lock`: the `sha1 0.10.7` entry and its reference (12 lines). The lock rule was lifted
  for this batch only. `cargo build --locked` first failed as predicted ("cannot update the lock file"); one plain
  `cargo build --offline` regenerated it and `--locked` passes afterwards. `cpufeatures` and `digest` stay.
- CI: the macOS XPC smoke step and the `oven-sh/setup-bun` step that existed only for it (rust-platforms job).
  Release: the identity import for the helper, both `OARLOCK_DISTRIBUTION_BUILD` lines and the helper verification.

## 3. Replacement signature check

`release.yml` step "Verify the packaged macOS app signature" (macOS legs only, between the build and the upload, so
build, verify, upload order is kept and `tagName` stays on the non-macOS leg): `set -euo pipefail`; fails unless
`APPLE_TEAM_ID` matches `^[A-Z0-9]{10}$`; requires exactly one `*.app` in
`src-tauri/target/$OARLOCK_RELEASE_TARGET/release/bundle/macos` (nullglob and a count check); reads the identifier
with `jq -r .identifier src-tauri/tauri.conf.json`; runs `codesign --verify --deep --strict -R="anchor apple generic and
certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\" and identifier \"$id\"" <app>` (the `=` after `-R` marks requirement
text).

`scripts/releaseWorkflow.test.ts`:
- `verifies the macOS bundle before anything is uploaded to the release` finds the step by its command
  (`codesign --verify --deep --strict`), checks its name, `if: startsWith(matrix.platform, 'macos')`,
  `set -euo pipefail`, the `jq` read, the `-R="anchor apple generic and certificate leaf[subject.OU] = ` text, the
  team id and the quoted identifier, then the existing order and upload assertions.
- `the signature check needs a team id and exactly one app, and hands codesign requirement text` extracts the
  step's bash and runs it in a temporary directory with a stub `codesign`: success passes the exact argument list
  (`--verify --deep --strict`, the `-R=` requirement, the app path); an unset, empty, lowercase, short and long team
  id, zero apps and two apps all exit non-zero (two apps with "exactly one packaged app" on stderr).

## 4. Notes

- `build.rs` no longer links Foundation and Security explicitly. The Darwin build (`cargo build`, clippy, tests)
  passes, so objc2-foundation and security-framework link what they need; Linux and Windows are unaffected (the
  removed code was macOS-only).
- Nothing in the frontend changed; `bun run size` and `check:dist` were not run.
- The local `codesign` path of the new step was exercised only through the stub; the real certificate chain, the
  `-R=` handling against a real signed bundle and notarization are not covered here and need the first signed
  release run. Windows and Linux were not built.
- The history sections of `AGENTS.md` (Reviews 67 to 80), `REVIEW_LEDGER.md` and earlier batch notes still describe
  the removed design and were deliberately not rewritten.

## 5. Checks (macOS arm64, in the worktree)

```
cargo build --locked                                   Finished (after one plain cargo build --offline for the lock)
cargo clippy --all-targets --locked -- -D warnings     Finished, no warnings
cargo test --locked -- --test-threads=1
  lib: 1644 passed; 0 failed; 4 ignored
  integration binaries: all ok (git_ai_diff 8, git_entrypoint_guard 32, git_executable_refusal 10,
  git_operations 61, git_remote_scope 15, git_store_aliases 2, git_fixture_isolation 2, fs_search 25 ...)
  the lib count was not taken on the base; 31 tests went with the deleted code (27 in the four modules and the
  integration file, 4 CandidateConfig tests)
bun run check-types                                    clean
bun run lint                                           Found 80 warnings (none in the changed files)
bun run test                                           646 files passed; 6200 passed | 2 skipped
bun run vitest run scripts/releaseWorkflow.test.ts     3 passed
```

Residual search for `git-worker`, `git_execution_capability`, `OarlockGitWorker`, `candidate_index`,
`index_publication`, `candidate_object`, `CandidateConfig`, `oarlock_git_worker_probe` and
`OARLOCK_DISTRIBUTION_BUILD` hits only `AGENTS.md` review history, `REVIEW_LEDGER.md`, `docs/reviews/`.
