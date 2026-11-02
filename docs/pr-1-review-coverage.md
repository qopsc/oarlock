# PR #1 review coverage

This is a coverage and release-risk record, not a certification. Reviews include
uncommitted fixes in the shared working tree. Passing tests do not certify the
current remote PR or untested platforms. Detailed historical evidence remains in
AGENTS.md; the history was not converted into an invented percentage complete.

## Current pass: 106

Implemented the approved native transactional theme store; AI remains on hold.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Theme transactions | Native mutex, per-ID batch upserts/deletion, validation before commit; revisions published after persistence | Real-file concurrent tests preserve independent imports and deletion |
| Migration/recovery | New native catalog; original plugin file retained; plugin denied access to both names; malformed data/read errors never become defaults | Migration, corruption, external modification, symlink and recovery tests pass |
| Publication | Reuse shared per-file lock, conditional versions, private staging, ACL/metadata preservation | ACL preservation and unsupported-metadata failure tests pass; Windows remains blocked by the existing safe-write implementation |
| UI synchronization | Subscribe before read, accept only newer full snapshots, ignore stale replies and late failures after a newer success | Snapshot ordering, lifecycle and Retry tests pass |
| Settings feedback | Readiness/error/Retry controls; imports wait for loading; failed delete keeps selection; delayed completion preserves newer selection; theme-file ingestion reports failure | Type checks and frontend regression suite pass |

Same-ID edits retain last-commit-wins semantics; this change protects independent
IDs rather than introducing field merging. No new revision is published on a failed
commit. The 50 MiB catalog bound matches the existing conditional writer. Native
files changed externally require recovery/restart; damaged bytes are preserved.
Built-in themes remain usable when custom storage is unavailable.

Validation: **5,413 frontend tests in 583 files**, **1,540 native tests**, three
ignored; types, lint (79 existing warnings), Clippy with warnings denied, formatting,
whitespace, build, startup graph and size pass. Total JS **2,880,576 gzip bytes**
(-1,500), unchanged budget 2,882,080; startup 251,032 (-40), primary terminal 95,786 (+1), with
unchanged budgets. No dependencies or idle polling added. Native mutations use one
IPC; committed events carry the snapshot without a follow-up read.

The two deliberately failing theme reproductions were removed after their
invariants were promoted to native tests. See `scripts/theme-review/README.md` and
`/tmp/oarlock-review106-*.log`. No additional XML work or AI work. Existing Git/Undo
and platform blockers remain; specifically, Windows custom-theme migration/saves
fail safely until the shared native writer is implemented there. Other-platform
runtime validation remains outstanding. No commit or push.

## Pass 105

Moved away from Vim/XML implementation into themes, CLI control and macOS menu
dispatch. AI remains on hold; no new architecture was changed.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Prior fixes | Focused language-identity, parser-lifetime and preview tests, plus inspection of the new shared language and port-check code | No new failure reproduced; no further XML changes or corpus rerun |
| CLI background open | A controlled hook test with paint callbacks withheld opened the tab but never answered `oarlock open --no-focus` | Reply after accepting the tab/navigation; no animation-frame dependency |
| CLI bridge teardown | Closing the bridge during window.show or delivering an already queued event still opened a tab | Reject retired bridge requests before actions and after awaited focus; return frontend_unavailable |
| Native menu dispatch | Two controlled tests delivered queued callbacks after teardown, including while native listener registration was pending | Retired bridge ignores callbacks; eventual unlisten still runs |
| Theme persistence | Concurrent independent imports lost one theme; saving another theme concurrently with deletion resurrected the deleted theme | Two reproductions confirmed; native transactional storage/revisioned snapshots requested, implementation held |
| Additional inspection | Background import/removal, theme file ingestion, shortcut predicates, control routing and updater gating | Read-only inspection, not exhaustive certification. Background-selection lifetimes and stale CLI caller fallback remain follow-up targets |

The theme reproductions call production functions against a shared mock store;
they establish the read/modify/write race, not a native multiwindow integration
result. They intentionally fail only under `scripts/theme-review/vitest.config.ts`.
No theme data was changed. The native ownership decision is pending.

Validation: **5,408 regular frontend tests in 582 files**, **1,532 native tests**,
three ignored; types, lint (79 existing warnings), Clippy, touched-file formatting,
whitespace, build, startup graph and size checks pass. Focused prior-fix/control
checks: 70 tests in 12 files; shortcuts/control: 76 tests in nine files. No native
production changes. Total JS 2,882,076 gzip bytes (+33), budget 2,882,080 (+30);
startup 251,072 (+27), primary terminal unchanged at 95,785, with unchanged budgets.
No dependencies, timers or IPC round trips added; CLI open removes a frame wait.

Evidence: `/tmp/oarlock-review105-*.log`, size JSON and
`scripts/theme-review/README.md`. Prior 27-case WebKit / 714-of-715 Vim results
remain pass 104 evidence, not repeated certification. Existing Git/Undo/Windows
and cross-platform release blockers remain. No commit or push.

## Pass 104

AI remains on hold. Implemented the three approved language/preview decisions,
then reviewed those changes for mount, formatting, LSP and navigation regressions.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Vim filetype | Adapter ignored mode writes. Bind `filetype`/`ft` to the existing persisted document override; share highlighting, formatter hints, LSP and status. Empty selects plain text; `ft&` restores filename detection | Real WebKit command/reset/rename checks pass |
| XML tag objects | Token-only XML supplied no structural tag tree | Lazy `@codemirror/lang-xml` 6.1.0; six corpus failures fixed, nested XML/attribute regression passes |
| Editor creation | Parent language effect could precede CodeMirror creation, leaving no parser | Attach to the creation callback; clear obsolete parsers before paint, install after child configuration; React/CodeMirror WebKit mount/replacement/disable regression passes |
| Formatter/LSP races | A previous language's formatter could return after a language change; status UI still used filename; custom extension fallback was lost during implementation | Discard stale format results, reject stale LSP attachments, use shared identity including custom LSP extensions; native syntax hints cannot change authorized paths |
| Preview navigation | Late port checks replaced manually typed/submitted URLs and survived close | Exact-check cancellation, 900 ms deadline, response body cancellation, active tab/space ownership; supersession and hidden-preview tests pass |

The 715-case comparison now passes **709 baseline / 714 fork**, with no added
failures. Both use structural XML; legacy CM5 defineMode registration is omitted
only under CM6, preserving the filetype assertions. One malformed-JavaScript
block-indent expectation remains; valid-JavaScript indentation passes. All **27**
focused WebKit cases pass with no plugin errors. This does not establish complete
Vim parity or certify every LazyVim configuration. Terminal code is unchanged;
pass 102's real LazyVim smoke was not repeated.

Validation: **5,403 frontend tests in 580 files**, **1,532 native tests**, three
ignored. Types, lint (79 existing warnings), Clippy with warnings denied, Rust
formatting, whitespace, build, startup graph and size checks pass. New helpers and
tests are formatted; vendored sources retain upstream formatting. Total client JS
is **2,882,043 gzip bytes** (+4,322); the approved lazy XML dependency and these
fixes raise only the total budget to 2,882,050. Startup is 251,045 (-198); primary
terminal remains 95,785, with unchanged budgets. No idle parser/probe worker or
probe timer is added. The old intentionally failing preview fixtures are promoted
into the regular passing suite.

Evidence: `/tmp/oarlock-review104-*.log`, size JSON, and
`scripts/vim-review/README.md` / `scripts/preview-review/README.md`.
Existing Git/Undo/Windows/platform release blockers below remain. No commit or
push; passing local tests do not certify the remote PR.

## Pass 103

AI remains on hold. Investigated the Vim failures, fixed two production defects
within the approved fork design, and moved into browser preview navigation.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Vim harness | Match app key precedence, multiple selections, Tab handling, layout measurement, stable line metrics, pixel rounding, platform flags and native word-selection keys | Same corrected harness tests pristine and forked packages; no cases removed |
| Block indentation | Four shifts added sixteen spaces with indent width two and tab display width four | Fixed space indentation to use indent width; WebKit shift/unshift regression passes |
| Explicit scrolling | Automatic cursor reveal displaced z<CR>/z- five pixels from zt/zb after cursor movement | Explicit scroll wins within its operation; unit and WebKit regressions pass |
| Clipboard fixture | Synchronous upstream simulation expected two copies before deferred selection cleanup; awaited helpers had already settled cleanup | Test now follows distinct browser-event timing; verifies copied text, insert-mode preservation and subsequent escape without selection |
| XML tag objects | Six dit/dat cases require a structural tag tree; the app's XML parser supplies tokens only. A structural HTML-parser run passed the same cases, but HTML cannot stand in for XML semantics | Structural XML parser decision requested; XML parser unchanged |
| Filetype | Two upstream tests depend on absent CodeMirror 5 defineMode; separately, adapter setOption/getOption omit mode, so set filetype is silently ignored | Shared per-document language override decision requested; implementation held |
| JavaScript indentation | Remaining S-block expectation follows malformed `1hello{`; modern parser differs. Separate valid-JavaScript block preserves indentation | Parser-dependent compatibility limitation retained, not counted as passing |
| Preview port checks | Deferred port 5173 completion overrides newer manual port 8000 navigation; unmount leaves its fetch signal live | Two reproductions confirmed. Visible-preview ownership/cancellation decision requested; production fix held |

The corrected 715-case comparison passes **703 baseline / 706 fork**, with no
added failures. Nine remain: six XML, two filetype and the malformed-JavaScript
indentation expectation. This replaces the unexplained 93-failure figure; it does
not establish complete Vim parity. All 24 focused actual WKWebView cases pass
without plugin errors, including previous worker timeout/recovery, macros,
command ordering, cancellation and undo checks.

Validation: 5,363 regular frontend tests in 573 files; 1,531 native tests, three
ignored; types, lint (80 existing warnings), Clippy, build, startup graph and size
pass. The two intentionally failing preview reproductions run only through their
explicit config, outside the passing suite, pending the architecture decision.
Native production code is unchanged. Client JS: 2,877,721 gzip bytes (+13), total
budget 2,877,730; startup 251,243 and primary terminal 95,785 remain within unchanged
budgets. No dependencies added. Touched helpers/fixtures are formatted; vendored
sources retain upstream formatting.

Fixtures: `scripts/vim-review/README.md`, `scripts/preview-review/README.md`.
Evidence: `/tmp/oarlock-review103-*.log`, corpus-comparison and size JSON files.
Terminal LazyVim's pass 102 smoke was not repeated: only editor forks changed.
Native-app and other-platform certification and existing Git/Undo/platform
blockers remain outstanding. No commit or push.

## Earlier pass: 102

AI remains on hold. Implemented the approved compatible Vim forks and checked
LazyVim through the terminal input/model path. This is completion and regression
review of the approved search architecture, not additional repository-wide
coverage. No Vim commands were intentionally disabled or routed to another panel.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Built-in Vim search | Pinned local core/adapter forks propagate resumable search through operators, counts, macros, mappings, Ex ranges, global, sort and substitution | 21 focused actual-WebKit cases pass, including real hostile-pattern timeout and recovery |
| Command ownership | Ordered input; resumed edits validate editor generation, document, visibility and permissions; external edits and retargeting cancel pending work | Unit and WebKit regressions cover stale substitution, queued typing, confirmation cancellation and one-step undo |
| Fork regressions | Fixed mapped searches consuming macro prompt history, premature recording-banner closure, dispatch during editor update, shared highlight timer and duplicate substitution completion | Compatibility comparison has no failures added by the fork |
| Resource bounds | Disposable worker, shared four-worker cap, bounded patterns/documents/results/replacements, ten-second command deadline, 256 queued input entries | Real worker termination and subsequent admission pass; synchronous editing has no worker/timer |
| Upstream compatibility | Same adapted 715-case corpus run against pristine published packages and maintained forks | Both pass 622 cases; 93 baseline/fixture failures remain unresolved, not a complete Vim certification |
| Terminal LazyVim | Real Neovim PTY with production Ghostty WASM and input encoder, isolated configuration/state, installed LazyVim plugins | LazyVim 16.0.1 on Neovim 0.12.6 passes startup, file picker, Escape, editing, substitution and :wq |

Validation: 5,361 frontend tests in 572 files; 1,531 native tests, three ignored;
types, lint (80 existing warnings), Clippy with warnings denied, build, startup
graph and size pass. The new fork helper/test files are formatted; pristine
vendored sources retain upstream formatting. Native code was unchanged this pass.
Client JS is 2,877,708 gzip bytes (+17,322), with the total budget adjusted to
2,877,710 for the approved lazy Vim/worker implementation. Startup is 251,242
and primary terminal 95,785 bytes, within their unchanged limits. No additional
third-party runtime dependency; baseline/test code is excluded from the app build.

The corpus limitations need investigation before claiming full built-in Vim
compatibility. Terminal evidence does not cover the user's entire LazyVim config,
native app shortcut interception, rendering, or other platforms. Existing Git,
Undo and platform release blockers below remain. No commit or push.

Fixtures and reproducible commands: `scripts/vim-review/README.md`.
Evidence: `/tmp/oarlock-review102-*.log`, corpus-comparison and size JSON files.

## Earlier pass: 101

AI remains on hold. Implemented the approved editor Find/Replace worker boundary
and project-search ownership. The separate Vim compatibility question below is
still pending; the complete editor regex surface is not yet certified.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Editor Find/Replace | Regex query data is held outside CodeMirror's native regex state; panel actions, search shortcuts, highlights and counting use bounded worker results | Worker and actual WKWebView integration tests pass; literal search retains its existing path |
| Replacement ownership | Results belong to the captured document/query; queued replacement also checks selection and current read-only state | Tests reject delayed edits after document/query/selection changes, read-only changes, close, hide and destruction |
| Regex failure/recovery | Ten-second worker deadline, bounded input/output/results, explicit errors and Retry; empty regex toggle starts no worker; automatic starts debounce 100 ms | Real hostile worker terminates while caller stays responsive; subsequent replacement scan succeeds |
| Project search scope | Queries/results carry space, environment and root; navigation clears retained results and aborts work | Previously skipped same-root Ubuntu-to-Debian regression enabled and passing |
| Search result opening | Authorization uses the result's environment; ownership/root rechecked after the await and before opening in the originating space | Regression refuses delayed opening after navigation |
| Native grep cancellation | Page-generation admission, exact request IDs, separate 16-request registry; cancellation retried after admission acknowledgment | Native tests cover page retirement, cross-window isolation, old cancellation versus newer work, and retaining slots until blocking walks stop |
| Vim regex | Real CodeMirror-Vim adapter getSearchCursor/findNext exceeded two seconds on the same hostile input | Unresolved. Asked whether to route Vim search/substitution to the safe panel and visibly refuse unsupported search motions, or redesign the synchronous Vim adapter |

Editor limits: four active workers per page; 4,096 UTF-16 units for pattern and
replacement; 8,388,608 units (16 MiB UTF-16) for document and aggregate replacement
output; 10,000 matches; ten seconds per scan including startup/delivery. Limits
fail visibly, never partially Replace All. Select All keeps the existing
1,000-selection limit. Whole-word boundaries use the owning document's language
categorizer. Workers are created only for active regex work and terminated on
completion/cancellation/error; obsolete replies cannot mutate the editor.

Project search no longer uses dispatch-order channel supersession, which could
let an old late admission cancel newer work. Each frontend owner cancels its exact
native request. Native cancellation is cooperative: it checks before authorization,
between files and at matched lines; a blocked OS filesystem operation cannot be
forcibly interrupted, so its admission slot remains occupied until it exits.
Reload/close invalidates the page before cancelling registered work. This reuses
shared page/admission infrastructure; no AI execution behavior was changed.

Validation: 5,246 frontend tests across 567 files, no skips; 1,531 native tests,
three ignored. Types, lint (80 existing warnings), Clippy, build, startup graph,
size and touched formatting pass. Existing unrelated formatter differences remain,
including two older lines in CommandPalette.tsx preserved by this pass. The real
macOS WKWebView fixture verifies worker loading under tauri://localhost and the
production CSP, responsive timeout, highlight rendering, Replace All and external
query interception. It is not full Tauri or Windows/Linux webview certification.

Client JS: 2,860,386 gzip bytes (+22,290), budget 2,860,390; startup 251,243 (+27)
within its unchanged limit; primary terminal 95,785 within its unchanged limit.
The separate editor worker includes the existing CodeMirror search/state code so
regex/replacement semantics remain consistent, without adding a dependency. It
loads only on regex use. Existing Git/Undo/platform release blockers remain.
No commit or push.

Fixtures: scripts/editor-search/README.md and scripts/search-review/README.md.
Logs: /tmp/oarlock-review101-{query,focused,frontend-tests,rust-tests,types,lint,clippy,build,dist,format,webkit,vim-before}.log;
measurements: /tmp/oarlock-review101-size.json. External Morph code search was
rejected by automatic approval review because it could export repository content;
implementation research continued entirely through local source inspection.

## Previous pass: 100

AI remains on hold. Rechecked the terminal regex worker fixes, then moved into
editor Find/Replace and sidebar/palette content-search lifetimes.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Terminal regex | Existing worker, cancellation, limit, retry and real-worker regressions pass in the focused and full suites | No new terminal regex defect confirmed this pass |
| Query Retry | Hook test dispatched twice when Retry ran before the debounce expired | Fixed: Retry consumes the queued debounce before starting |
| Query cleanup | A delayed reply performed two state writes after the hook unmounted | Fixed: cleanup invalidates the existing request generation and clears the timer |
| Runner failures | Synchronous runner exceptions escaped the promise chain and left loading unresolved | Fixed: synchronous and asynchronous failures share the recoverable error path |
| Editor regex | Production MatchScan and CodeMirror cursor both exceeded a two-second external deadline on a roughly 1 KiB document using `(a+)+$` | Unresolved. Asked whether to isolate all editor regex operations or disable editor regex for this release; counter-only isolation would leave Find/Replace/highlighting exposed |
| Project-search workspace | Hook regression retains Ubuntu results and starts no new search when switching to Debian with the same `/repo` root; result opening uses current environment | Unresolved. Asked whether requests/results should carry workspace ownership and native cancellation. Regression explicitly skipped while the architecture decision is pending |

The query changes affect the existing shared hook used by command history,
palette content search and sidebar content search. They suppress obsolete UI
publication; they do not claim to cancel native filesystem walks. Project-search
ownership and editor regex execution were not redesigned without approval.
The reproduction and safe external-deadline launcher are documented in
scripts/search-review/README.md. Neither held issue is counted as fixed.

Validation: 5,221 frontend tests pass across 562 files, with one explicitly held
workspace-search regression skipped. 1,529 native tests pass, three ignored.
Types, lint (80 existing warnings), Clippy, build, startup graph, size and touched
formatting pass. The first sandboxed frontend run could not bind loopback servers;
the full rerun with loopback access passed. Existing unrelated repository-wide
format differences remain. Client JS is 2,838,096 gzip bytes (+40), budget
2,838,100; primary terminal is unchanged at 95,788. Startup is 251,216 within its
unchanged budget. One timer ref and callback per mounted query hook, no new
dependency, IPC or idle work. No commit or push.

Logs: /tmp/oarlock-review100-{query-before,editor-before,focused,final-focused,frontend-tests,rust-tests,types,lint,clippy,build,dist,format}.log;
measurements: /tmp/oarlock-review100-size.json. Existing release blockers below
remain alongside the two pending search architecture decisions.

## Previous pass: 99

AI remains on hold. Implemented the approved disposable-worker boundary for
terminal regex search. Literal search retains its native path.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Regex UI freeze | The production engine's `(a+)+$` regression now runs in a real worker; it timed out at 1,004 ms while the caller recorded 91 heartbeat ticks, then a fresh normal search succeeded | Fixed; compilation and evaluation no longer run on the UI thread |
| Admission and input | Four active workers per page, one batch per search; bounded rows, cells, text, pattern length and total scan time | Oversized work is refused visibly, never silently truncated |
| Cancellation | Query changes, output changes, suspension, clear and disposal terminate obsolete workers; late success and failure replies cannot change current results | Focused lifecycle tests pass; streaming output waits 100 ms of quiet before restarting |
| Failure recovery | Errors clear partial matches and show Search failed · Retry; failures survive renderer replacement and do not automatically restart on output | Controller tests cover explicit Retry and sticky failure |
| Match cap | Evaluation previously called regex.exec once more after reaching the result cap | Fixed and covered by an evaluation-count regression |
| Webview loading | Packaged worker loaded under tauri://localhost and the production CSP in an isolated macOS WKWebView; hostile-pattern timeout and wide-cell recovery passed | Actual macOS webview evidence; full Tauri and Windows/Linux webview testing remain outstanding |

Limits: 4,096 UTF-16 pattern units; 128 rows, 65,536 cells and 131,072 UTF-16
text units per batch; 8,388,608 text units (16 MiB of UTF-16) and ten seconds per
scan; one second per batch including worker startup/delivery. The existing
10,000-match cap remains. UI row extraction yields between rows after four
milliseconds; it never evaluates regex. Workers exist only during active scans
and terminate on completion, failure or cancellation. A timer enforces each batch
deadline, and replies also check elapsed time before acceptance. No frame polling
while a batch is pending, new dependency, native IPC or idle worker.

Validation: 5,217 frontend tests across 561 files; 1,529 native tests, three ignored;
types, lint (80 existing warnings), Clippy, production build, startup graph and
size checks pass. Changed frontend files are formatted; unrelated repository-wide
formatting differences recorded in pass 98 remain. Client JS is 2,838,056 gzip
bytes (+2,187), budget 2,838,060; primary terminal is 95,788 (+1,354), budget 95,790;
startup is 251,218 (+103) within its unchanged budget. Existing release blockers
below remain; these results do not certify the complete PR. No commit or push.

The repeatable worker/WebKit fixtures are in scripts/terminal-search and
scripts/terminal-shell-drop/regex-worker-probe.mjs. The old regex-probe.mjs now
runs the passing worker regression; pass 98's before-fix log retains the stall.
Logs: /tmp/oarlock-review99-{frontend-tests,final-focused,rust-tests,types,lint,clippy,build,dist,worker-real,webkit,format}.log;
measurements: /tmp/oarlock-review99-size.json.

## Previous pass: 98

AI remains on hold. Implemented the approved terminal shell/environment ownership
and verified-command-bar insertion policies, then moved into terminal regex search.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Shell-specific drops | Real sh/bash/zsh tests preserve substitutions, quotes and backslashes as literal filename text; quoting uses the native target dialect, not the host OS | Former held regression enabled; no global Windows quoting fallback |
| Native shell ownership | PTY-owned launch executable, original foreground group and process image are checked; unknown, replaced, nested and shared-group readers are refused | Five native tests pass; macOS sh-launcher selection handled |
| WSL paths | Launch wrapper binds a random token to the Linux shell PID; bounded helper verifies executable/foreground-group ownership and converts host paths with wslpath in the owning distro | Real Linux PTY helper tests pass; Windows/WSL runtime and actual wslpath conversion remain unverified |
| Command-bar insertion | A real sh reproduction evaluated a substitution when an otherwise quoted filename was pasted inside an unfinished double quote | Approved conservative argument-boundary check; raw/ambiguous input is refused visibly; changed editor state rejects delayed insertion |
| Drop lifetimes | Captured PTY generation and navigation lifetime reject delayed replies after close/restart/tab/space switches; Explorer forwards the source environment and cancels its drag on source-scope changes | Focused cancellation and environment propagation coverage passes |
| Regex search | Production RegexTerminalSearch.step(2000) with `(a+)+$` and 31-character lines exceeded a one-second subprocess deadline | Confirmed unresolved UI-stall risk. Disposable worker/bounded execution versus disabling regex is awaiting the user's decision |

Registered application drops retain their existing OSC72 route. Shell insertion
requires the command bar and a plain, unquoted argument boundary; multiple cursors,
control characters, compound syntax, unknown shells and cmd filenames containing
percent/exclamation/quote expansion hazards are refused. PowerShell and fish use
their own literal quoting rules. Windows shells with unverifiable launch wrappers
or process snapshots are refused, not treated as a known shell by filename alone.
No claim of Windows, Git Bash wrapper, fish or PowerShell desktop validation.

The Linux helper initially admitted a child sharing its parent's foreground group;
the real PTY test caught it, and exact sole-group ownership now rejects it. macOS's
/bin/sh launcher initially caused a timing-dependent identity refusal in the full
suite; capturing /private/var/select/sh at launch resolved it. Tests now wait for
real exec/group transitions before asserting rejection and clean up on failure.
The checked-in Linux harness is scripts/terminal-shell-drop/probe.py. Its container
was offline and removed automatically. This validates the Linux /proc ownership
logic, not a complete Windows/WSL or Linux Tauri build.

Validation: 5,192 frontend tests across 557 files; 1,529 native tests, three ignored;
types, lint (80 existing warnings), Clippy, production build, startup graph, size
and whitespace checks pass. Changed frontend files are formatted. The repository-
wide formatter still reports differences in other existing files, including
src/app/dist-budget.test.ts and src/app/hooks/useTabCloseGuards.ts; this pass does
not rewrite those unrelated changes. Existing Git/Undo/Windows/Wayland release
limitations remain. No commit or push.

Client JS is 2,835,869 gzip bytes (+947), budget 2,835,870. Primary terminal JS is
94,434 (+335), budget 94,440. Startup is 251,115 within its unchanged budget.
Quoting/preparation loads on demand. One native preparation call is added per
shell-path drop, with no new dependency, polling or per-frame work. Each terminal
retains its launch descriptor and one preparation flag; only one native preparation
per terminal runs at a time. The WSL helper has a four-second Linux timeout and a
five-second host wait; cancelled UI ownership suppresses delivery, without claiming
that an already-started OS/process probe can be undone.

Logs: /tmp/oarlock-review98-{focused,native-drop,linux-probe,frontend-tests,rust-tests,types,lint,clippy,build,dist,size,format,regex-before}.log;
measurements: /tmp/oarlock-review98-size.json. The bounded regex reproduction is
scripts/terminal-shell-drop/regex-probe.mjs; it reports scan-started then ETIMEDOUT.
The regex architecture question remains open, and no search architecture change
was made in this pass.

## Previous pass: 97

AI remains on hold. Rechecked the clipboard/focus regressions and moved into
terminal file drops, Explorer copy authorization, and relative-path copying.

| Area | Evidence and change | Status |
| --- | --- | --- |
| POSIX dropped filenames | A real shell consumed a literal backslash from a filename. The POSIX formatter now quotes backslashes, including drive-like literal paths | Regression failed before the fix and passes afterward |
| Explorer authorization wait | Controlled tests dispatched fs_copy after Explorer closed or its environment changed during source authorization | Recheck existing disposal/root/environment state before dispatch; success and cancellation tests pass |
| Clipboard file paste | A workspace switch during authorization still allowed the old copy to start despite the existing owner predicate | Recheck isCurrent after authorization and mark copyStarted at actual dispatch; regression passes |
| Copy Relative Path | Roots / and C:/ incorrectly returned absolute descendant paths because the prefix gained an extra slash | Handle an existing trailing slash; both regressions pass |
| Shell-specific drop quoting | Windows-style quoting fed to /bin/sh evaluated a harmless command substitution embedded in a filename | Confirmed unresolved risk. Shell/environment ownership and unknown-context policy are awaiting the user's decision; regression explicitly skipped |

The held shell test exercises the actual Windows formatter with a real POSIX
parser. It is not a Windows desktop test. No global quote replacement was made:
correct insertion depends on the target shell, its environment and the meaning of
the source host path. The proposed architecture is to bind that context, translate
WSL paths, and refuse unknown shell contexts. The alternative offered was to
disable shell path insertion for this release. This risk remains a release blocker.

Validation: 5,172 frontend tests pass across 554 files, with the one held test
skipped in a separate file; 44 focused tests pass with the same skip. All 1,524
native tests pass (three ignored on macOS). Types, lint (80 existing warnings),
Clippy, build, startup graph, formatting and whitespace pass. Existing Wayland
real-desktop/full-Linux-build, Windows, Git/Undo and other platform limitations
remain; the passing suites do not certify the remote PR or those platforms.

Client JS is 2,834,922 gzip bytes (+45), budget 2,834,930. Primary terminal JS is
unchanged at 94,099; startup is 251,087 within its unchanged budget. The tiny total
budget increase covers quoting, path-prefix and cancellation checks. No new
dependency, timer, native IPC or per-frame work. No AI execution changes, commit
or push.

Logs: /tmp/oarlock-review97-{quote-before,lifetime-before,relative-before,focused,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
measurements: /tmp/oarlock-review97-size.json.

## Previous pass: 96

Implemented the approved Wayland policy: native terminal clipboard reads require
the requesting window's keyboard focus and become invalid when focus is lost.
AI execution remains on hold. The policy decision from pass 95 is resolved;
full desktop/runtime qualification remains outstanding.

| Area | Change and evidence | Status |
| --- | --- | --- |
| Wayland admission | The native GTK boundary recognizes Wayland and checks the requesting window, rather than refusing all reads via GTK's generic notification flag | Compiles against GTK; headless Weston test confirms background reads are refused |
| Focus lifetime | Each window owns a focus epoch. Pending captures fail on focus loss/destruction and release handlers/timer. A loss/regain cycle changes the image-cache revision and invalidates encoding results still in progress | Pure state tests and real GTK focus-transition test under Xvfb pass |
| Delayed replies | Native marks focus-required snapshots; frontend rejects replies after blur, including blur followed by regain before delivery. Observers are removed when reads finish | Two frontend cases pass; non-Wayland reads retain their policy |
| Ownership cleanup | Native window destruction retires the epoch and removes its registry entry; pending capture observers are detached | GTK display regression verifies cleanup and background-window rejection |

Validation: 5,165 frontend tests in 554 files and 1,524 native tests pass on macOS
arm64 (three ignored), with types, lint (80 existing warnings), Clippy, build,
startup graph, formatting and whitespace passing. The production Linux module
also compiles in an Ubuntu arm64 GTK harness with stubbed Tauri and image-encoding boundaries;
checked-in GTK focus and Wayland background tests pass under Xvfb and Weston.
The Linux display tests are explicitly ignored in ordinary headless runs. The
seatless Weston test emits a missing-seat diagnostic and only validates refusal
without focus, not focused text/image capture. The container was removed afterward.

Still required: a complete Linux application build, focused text/image paste on
real Wayland desktops, and Windows runtime validation. OS reads/encoding already
started are not claimed forcibly interrupted; their results are invalidated.
Existing Git/Undo/Windows/platform release blockers remain.

Total client JS is 2,834,877 gzip bytes (+171), budget 2,834,880. Primary terminal
JS is 94,099 (+175), budget 94,100. Startup is 251,077 within the unchanged budget.
No new dependency package or polling; native bookkeeping is lazy per Wayland
window and frontend blur observation exists only while a read is unfinished.
No AI execution changes, commit or push.

Logs: /tmp/oarlock-review96-{native-focus,focus-ui,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
Linux harness/logs: /tmp/oarlock-review96-linux/; measurements: /tmp/oarlock-review96-size.json.

## Previous pass: 95

AI execution remains on hold. Implemented version-checked terminal clipboard
snapshots and moved on to terminal/Explorer file-drop lifetimes. The Wayland
read policy is pending; this is not a cross-platform clipboard certification.

| Area | Change and evidence | Status |
| --- | --- | --- |
| Stale image cache | Controlled tests reproduced stale PNGs after both shared Copy and external replacement. Native captures verify one revision around text, image and encoding; reuse requires that revision | Regressions pass; macOS native unit checks pass |
| Coherent paste | Keyboard/Kitty reads use a single snapshot. Menu image Files use event metadata. beforeinput cannot combine its text with a newer OS image. Errors do not forward Ctrl+V or silently return a successful Kitty result | Real Ghostty SIMD/scalar input tests pass |
| Read ownership and cost | Page generations gate native admission/results; terminal signals reject delayed results. One image capture per page, one-second image retention, no encoding for text-only reads, no PNG retransmission on verified reuse | Queue, cancellation, frame-validation and cache tests pass |
| Linux | GTK owner notifications guard captures, with a callback deadline and off-thread pixel packing/encoding. PRIMARY retains its size limit | Linux compilation/runtime unverified. Wayland currently fails the capability gate; focus-only reads versus a background service is awaiting the user's decision |
| File drops | Retired listeners could act before delayed registration returned its cleanup: duplicate terminal paste and Explorer copy after disposal reproduced | Both callbacks now honor existing disposal state; both regressions pass |

GTK's Wayland backend returns false for the generic notification capability, while
its focused clipboard offers emit owner-change events. This means the generic gate
cannot simply be removed to certify background reads. Sources:
[GTK display implementation](https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gdk/wayland/gdkdisplay-wayland.c),
[GTK focused selection handling](https://raw.githubusercontent.com/GNOME/gtk/gtk-3-24/gdk/wayland/gdkdevice-wayland.c).
No Wayland behavior expansion has been made pending the lifecycle decision.

Validation: 5,163 frontend tests in 554 files; 126 focused clipboard/input/drop
tests; 1,522 native tests with three ignored. Types, lint (80 existing warnings),
Clippy, build, startup graph, formatting and whitespace pass on macOS arm64.
Linux/Windows runtime testing remains required. All previously documented
Git/Undo/Windows/platform release blockers remain.

Total client JS is 2,834,706 gzip bytes (+341 from pass 94), with a measured budget
of 2,834,710. Primary terminal JS is 93,924 (+557), budget 93,930. Startup is 251,076
within the unchanged 540,000-byte budget. No new dependency package or idle polling;
image-cache expiry uses one timer only while bytes are retained. Even cache hits
now need native version verification; combined captures replace separate image
and text reads. Native OS work already started is not claimed forcibly cancellable.

Logs: /tmp/oarlock-review95-{cache-before,terminal,drop-before,drop-after,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
measurements: /tmp/oarlock-review95-size.json. No commit or push.

## Previous pass: 94

Implemented the user's approved native clipboard write ownership and ordering
policies from pass 93. AI backend/request work remains on hold. Copy buttons in AI
renderers and MCP logs only changed to use the shared clipboard transport.

| Area | Change and evidence | Status |
| --- | --- | --- |
| Program write lifetime | Each write retains its terminal-generation signal and an exact native ticket. Closing/restarting cancels pending reservations, conversion results and queued commits. A late begin reply is cancelled before it can commit. Native page generations reject stale reload/close work | Both former held regressions enabled; cancellation before admission and during conversion tests pass |
| Native ordering | Text and images share app-wide reservation and commit ordering, separately for the ordinary clipboard and Linux PRIMARY. New reservations supersede older uncommitted work. Page-local sequence numbers reject delayed older admissions. Tickets are single-use and cancellation cannot affect another ticket/window | Native cross-window, cancellation, replay and sequence tests pass |
| OS commit boundary | Image conversion/decoding stays outside the OS commit lock. Page validity and current ticket are checked immediately before taking the irrevocable commit. OS commits are serialized per selection; retirement only removes small metadata | Native test holds an OS commit while retiring its page, then proves a superseded pending commit cannot run and the newer commit wins |
| Burst handling | Program writes still retain one running write and the latest pending value per selection. A parser burst reserves only its latest value; pending preparation reserves without waiting behind the active conversion. Replaced pending tasks release ownership | Queue coalescing, preparation and discard tests pass |
| Explicit Copy | Oarlock Copy buttons use the same native ordering. Browser/menu Copy and Cut announce an ordering barrier without replacing their native clipboard formats. Direct plugin write permission and the uncoordinated PRIMARY write command were removed | Frontend barrier and transport tests pass; no AI execution changes |
| Shell exit | Final program writes may complete while the terminal model remains open; close/restart revokes them. Clipboard reads/paste prompts still end with shell input. Late callbacks from replaced generations cannot enqueue work | Lifetime regression passes; retained scrollback link regressions still pass |

Ordering is defined by native admission, with per-page sequence protection for
requests delayed before admission. Once an OS commit starts it cannot be undone;
page retirement does not wait for that OS call. Browser/menu barriers cannot roll
back OS work already started. Copies made by other applications and cross-window
clipboard-image cache coherence remain separate review work, not covered guarantees.

Validation: 5,151 frontend tests in 552 files pass with no held skips; 55 focused
clipboard/link/ownership tests pass. All 1,519 native tests pass (three ignored),
as do types, lint (80 existing warnings), Clippy, build, startup graph, formatting
and whitespace checks. Total client JS is 2,834,365 gzip bytes (+1,200 from pass 93),
budget 2,834,370; primary terminal JS is 93,367 (+235), budget 93,370. Startup is
251,066 bytes within its unchanged budget. Native writes add one admission IPC
before commit; cancellations send an exact-ticket IPC. Metadata retains at most
two current tickets and two sequence entries per live page. No dependency or idle
polling was added; terminal program signals allocate only when first used.

Logs: /tmp/oarlock-review94-{terminal,native,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
size measurements: /tmp/oarlock-review94-size.json. These are macOS arm64 checks;
Linux/Windows clipboard/display behavior still needs runtime validation. Existing
Git/Undo/Windows/platform release blockers remain. No commit or push.

## Previous pass: 93

AI remains on hold. Reviewed terminal clipboard writes and rechecked pass 92 link,
prompt and clipboard ownership regressions. New write ownership and ordering
policies were asked before implementation and remain pending.

| Area | Evidence and outcome | Status |
| --- | --- | --- |
| Image write failures | A controlled native-IPC failure caused a valid image to be replaced with its text alternative while reporting success | Native failures distinguish decoding from OS commit failures. Only unusable images fall back to text; tests cover both failures and fallback |
| Browser conversion limits | A bitmap wider than the native 16,384-pixel limit proceeded to canvas allocation and IPC. Total RGBA size was also unchecked | Apply the existing side and 512 MiB RGBA limits before canvas allocation, closing the bitmap on rejection. Does not bound the browser decoder's initial allocation |
| Native grayscale expansion | A real grayscale PNG decoded within a 1 MiB test limit, then expanded to 2 MiB RGBA outside that limit | Check expanded RGBA size before conversion. The regression failed before the fix and passes now; production retains its existing 512 MiB limit |
| Write after terminal close | A delayed program image conversion still called native clipboard write after terminal lifetime disposal | Confirmed controlled reproduction; ownership decision pending, test explicitly skipped |
| Older image overwrites Copy | After a delayed program image started, an explicit text Copy completed; the old image then committed last | Confirmed controlled reproduction; native ordering decision pending, test explicitly skipped |

The two proposed policies bind uncommitted program writes to terminal/page lifetime
and order Oarlock-originated clipboard writes across windows. Neither is implemented
or claimed as fixed. Already-committed OS writes cannot be undone. Copies made by
other apps are outside the proposed ordering guarantee and remain a separate review
question. Linux PRIMARY already has native dispatch tickets; this pass does not
claim that mechanism lacks ordering or certify Linux display behavior on macOS.

Validation: 5,142 frontend tests in 551 files pass with the two held reproductions
skipped; 46 focused clipboard/link/ownership tests pass with the same two skips.
1,515 native tests pass (three ignored). Types, lint (80 existing warnings), Clippy
with warnings denied, production build, startup graph, formatting and whitespace
checks pass. Total client JS is 2,833,165 gzip bytes (+127), budget 2,833,170;
primary terminal JS is 93,132 bytes (+132), budget 93,140. Startup is 251,032 bytes
within its unchanged budget. No dependency or background timer was added. These are
macOS arm64 checks, not cross-platform runtime certification. No AI production edits,
commit or push.

Logs: /tmp/oarlock-review93-{clipboard-before,clipboard-after,native-before,terminal,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
size measurements: /tmp/oarlock-review93-size.json. Existing Git/Undo/Windows/platform
release blockers remain alongside the two new write ownership decisions.

## Previous pass: 92

AI remains on hold. Implemented the two approved terminal ownership changes from
pass 91 and reviewed the resulting asynchronous paths. This pass closes those
specific findings; it does not claim fresh whole-repository coverage.

| Area | Change and evidence | Status |
| --- | --- | --- |
| Terminal link ownership | Clicks capture space, terminal generation, environment and cwd before lazy loading. Navigation permanently invalidates earlier clicks, including away-and-back; restart/close invalidate the terminal owner. Shell exit retains clickable scrollback links. Checks precede later authorization, stat, file-manager/editor navigation and focus restoration | Prior reproduction and delayed navigation/restart/close tests pass |
| WSL links | Tilde expansion uses the originating distribution's home. Editor navigation explicitly targets the captured space and does not repeat authorization through the active window environment | Captured WSL home/environment/space regression passes |
| Clipboard consent | Prompts share one promise only for matching terminal generation, protocol, selection/types and program identity. Raw Kitty program names remain distinct even when display sanitization produces the same label | Cross-program and cross-terminal tests pass; eight-prompt cap retained |
| Clipboard cancellation | Restart/close/exit cancel prompts and reads; synchronous preference changes revoke reads. Late results cannot reach a replacement PTY. Permission cancellation denies held reads in the still-live terminal; fresh requests use the new permission generation | Previously held restart reproduction plus OSC52/Kitty permission-change tests pass |
| Delayed primary paste | Linux middle-click retains its initiating input controller and terminal generation | Guarded against delivery to a replacement input; shared lifetime and existing paste regressions pass |
| Diagnostic links | New cancellation tests exposed bare filenames such as main.rs:42:7 being classified as URL schemes and ignored | Separate parser test failed before fix and now passes |

All three held pass 91 reproductions are enabled and pass. Regression review also
caught shell exit disabling scrollback links; links now use the retained terminal
generation independently of clipboard/input shutdown, with a regression test.
Already-dispatched native
calls cannot be undone; cancellation suppresses subsequent steps and delivery. OSC52
provides no authenticated program identity, so its prompts are scoped by terminal
generation/protocol/selection; Kitty names are self-reported. No new policy for
terminal clipboard writes or external clipboard changes is claimed.

Validation: 5,137 frontend tests in 551 files, including 131 focused terminal tests,
and 1,513 native tests pass (three native ignored). Types, lint (80 existing warnings),
Clippy with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Client JS is 2,833,038 compressed bytes, 750 bytes above pass 91; the
allowance is 2,833,040. Primary terminal JS is 93,000 bytes, 444 bytes above pass 91;
its allowance is 93,000. Startup is 251,034 bytes within its unchanged budget.
No new dependency, timer or per-frame work was introduced. Lifetimes use two small
AbortControllers per terminal generation and one preferences subscription in the lazy
terminal module. These are macOS arm64 checks; other platform runtime validation
remains outstanding. No AI production edits, commit or push.

Logs: /tmp/oarlock-review92-{diagnostic-before,terminal,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log;
size measurements: /tmp/oarlock-review92-size.json. Existing Git/Undo/Windows/platform
release blockers remain. Further terminal review can move to program clipboard writes
and external clipboard changes without repeating these passing ownership checks.

## Previous pass: 91

AI remains on hold. Checked the ordered LSP writer and moved into terminal link
and clipboard lifetimes. The 88 focused LSP tests still pass; this pass does not
claim a new LSP defect or reopen the completed writer policy.

| Area | Evidence and outcome | Status |
| --- | --- | --- |
| Delayed keyboard paste | An empty clipboard read finishing after controller disposal still queried pasteEventsWanted, whose real model asserts that it is live | Check controller/model lifetime before consulting paste modes; regression passes |
| Clipboard image cache | An image read during a pending text write remained cached after that write replaced the clipboard with text | Text writes invalidate image reads on completion/failure as well as before starting; regression passes |
| Terminal file navigation | A controlled click began in Local, switched to Debian during async work, and authorized/stat-ed the file using Debian | Ownership decision pending: capture originating space/environment/cwd and cancel unfinished navigation on switch/restart/close |
| Clipboard consent | Approving the first program's prompt also approved another program's merged request | Ownership decision pending: scope prompts/replies to terminal generation and matching program/request; cancel on restart/close/permission changes |
| Clipboard reply after restart | Production integration callbacks plus the production BoundedPtyWriter delivered an old OSC52 read to a replacement PTY after detach/clear/attach | Same pending terminal-generation decision; confirmed unresolved |
| Repeated prompt requests | A burst of 20,000 repeated reads resolved successfully | Suspected recursive resolver overflow was not reproduced; no fix claimed |

The two ownership decisions were asked before implementation. Three regression
reproductions are explicitly skipped while they are held. They are not counted as
fixed or passing coverage, and the clipboard consent/restart issues remain release
risks. Existing program-write coalescing and one-second image-read reuse policy
were inspected, not redesigned or certified against every concurrent external
clipboard change.

Validation: 5,120 frontend tests in 550 files pass, with those three held skips.
All 1,513 native tests pass (three ignored), and types, lint (80 existing warnings),
Clippy with warnings denied, production build, startup graph, size, formatting and
whitespace checks pass. Client JS is 2,832,288 compressed bytes, four bytes above
pass 90, within the unchanged 2,832,290-byte allowance. Startup/terminal budgets are
unchanged. These are macOS arm64 checks; other platform runtime validation remains
outstanding. No AI production changes, commit or push.

Logs: /tmp/oarlock-review91-{ownership-before,clipboard-before,clipboard-after,prompt-burst-before,restart-before,terminal,lsp,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
Existing Git/Undo/Windows/platform release blockers remain. Next work depends on
the two ownership decisions; unreviewed terminal clipboard write cancellation and
external clipboard changes remain separate follow-up coverage.

## Previous pass: 90

Implemented the user's approved ordered LSP writer and failure policy. AI remains
on hold. This is completion and regression review of the pass 89 architecture
finding, not a claim of fresh whole-repository coverage.

| Area | Change and evidence | Status |
| --- | --- | --- |
| Ordered delivery | One native acknowledgment precedes the next send; both previously skipped ordering/admission reproductions now pass | Fixed |
| Queue admission | Maximum 256 messages and 16 MiB of UTF-8 payload, including the in-flight message; encoding length is counted without a second encoded document copy | Fixed |
| Failure ownership | Overflow, rejected writes and a 30-second stall close the transport, discard queued edits, kill the native session and preserve the failure through late exit/acknowledgment | Fixed |
| Native enforcement | Per-session write permit rejects concurrent calls before they queue behind stdin; native payload limit and independent deadline terminate stalled processes | Real-process timeout, concurrent admission and oversized-write tests pass |
| Recovery | Error state exposes the existing Restart action; stopped sessions no longer resume when the five-minute crash history expires | Explicit Restart/configuration change required; healthy project startup cannot clear a stopped project's error |

No dependencies or idle polling were added. The writer is allocated on first send;
its single frontend timer exists only during a write. Closing releases queued
strings and timers. Native retains the write permit until the blocking worker
actually finishes, even when its caller times out. Failure reasons are saved before
native termination so the exit event cannot race the UI into ordinary crash retry.
Page/window ownership remains enforced by the prior native boundary. The existing
process-tree mechanisms remain unchanged; this does not add support for deliberately
detached descendants. The byte budget is UTF-8 payload size, not a total heap/RSS cap.

Validation: 88 focused frontend LSP tests and 49 focused native LSP tests pass.
The full native suite passes 1,513 tests (three ignored); all-target Clippy passes
with warnings denied. All 5,117 frontend tests in 550 files pass with no skips.
Types, lint (80 existing warnings), formatting, whitespace, production build,
startup graph and size checks pass. Total client JS is 2,832,284 compressed bytes,
636 bytes above pass 89; the measured allowance is 2,832,290 bytes. Startup and
terminal budgets are unchanged.
These are macOS arm64 checks; Linux/Windows runtime and macOS Intel validation
remain outstanding. Existing Git publication, Undo and Windows staged-write/startup
recovery release blockers remain open.

Logs: /tmp/oarlock-review90-{lsp,native-lsp,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
The pass 89 before-fix writer logs remain the reproduction evidence. Next fresh
non-AI scope remains terminal link navigation/environment ownership and terminal
input/clipboard lifetime. No commit or push.

## Previous pass: 89

AI remains on hold. This pass reviewed LSP protocol behavior and editor navigation,
then moved into terminal link parsing. It did not revisit AI implementation.

| Area | Reproduction and outcome | Status |
| --- | --- | --- |
| LSP initialization | The client library catches initialization failures and resolves initializePromise; Oarlock then displayed a failed server as running | Readiness is checked before publishing running state; failed initialization closes the session and follows existing crash recovery |
| LSP request handling | With the real protocol client attached, a configuration request received both the correct array response and a second null response | Transport consumes handled server requests; early requests wait for the spawn ID before replying |
| Editor navigation | A delayed definition response opened another file after its originating editor closed | The view plugin's lifetime invalidates results after destruction/reconfiguration; picker callbacks check the same lifetime |
| Reference picker | Two references at different columns on one line collapsed into one | Entries retain their columns and display line/column labels |
| Terminal file links | Malformed percent escapes threw on click | Invalid file URI escapes return no target |
| Windows network-share links | Relative path resolution dropped the UNC prefix and could walk above the share root | Pure path resolution preserves server/share identity and clamps parent traversal at that root |
| LSP outbound admission | Controlled IPC fixture reproduced 257 simultaneous writes to a stalled target and didChange arriving before didOpen | Architecture decision pending; no ordered-writer implementation or new resource policy yet |

The pending proposal is one ordered writer, a 256-message / 16 MiB pending budget,
and session termination with visible Restart on overflow or a 30-second stalled
write. Dropping document edits would desynchronize analysis. The two reproductions
are explicitly skipped in transport.test.ts until that decision is implemented;
they remain known unresolved bugs, not passing regression coverage. Other tests
continue to exercise the prior page/configuration ownership fixes.

Native checks pass: 1,510 tests, three ignored, and all-target Clippy with warnings
denied. The frontend suite passes 5,107 tests in 549 files, with the two held writer
reproductions skipped. Types, lint (80 existing warnings), formatting, whitespace,
production build, startup graph and size checks pass. Total client JS measures
2,831,648 compressed bytes, 200 bytes above pass 88; the measured allowance is
2,831,650 bytes. Startup and terminal budgets are unchanged.
These checks run on macOS arm64. UNC behavior was tested as pure path handling;
Windows integration/runtime validation remains outstanding.

Logs: /tmp/oarlock-review89-{before,protocol-before,admission-before,references-before,terminal-before,lsp,terminal-after,frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
Existing Git publication, Undo, Windows staged-write/restoration and platform
release blockers remain open. Next fresh non-AI coverage: terminal link navigation
and environment ownership, then terminal input/clipboard lifetime. No commit or push.

## Previous pass: 88

The user put AI review on hold while considering a replacement backend. A bounded
stability check passed 59 tests across the existing HTTP transport, endpoint probes
and MCP Settings/discovery fixes. The complete frontend/native suites also cover
those fixes. This is not a certification of all AI behavior. OAuth token-read
recovery and remaining metadata parsing are deferred, not resolved by the proposed
backend replacement.

| Area | Evidence and change | Status |
| --- | --- | --- |
| Language-server startup | Regression reproduced a server attaching after Disable during startup | Approved configuration generations invalidate pending acquisitions on Disable, Restart, custom-server edits and shell changes |
| Native LSP ownership | Native sessions had no owning window/page and survived until app exit | Reservations bind to a native page generation; reload/close retire pending and live sessions only for that window; send/kill require that owner |
| Late LSP completion | Delayed starts and old exit callbacks could affect replacement sessions | Late startup replies are killed, stale generations cannot register/publish, and exit callbacks match the exact transport |
| LSP navigation input | Malformed URI escapes and malformed location results threw during navigation | URI decoding fails safely; definition/reference locations validate URI, range and nonnegative integer positions |

Ownership uses the existing native page-generation delivery; it adds no polling,
dependency or background work for unused LSP features. Native startup reserves
ownership before blocking environment/binary discovery. Retirement removes that
reservation; a child returned after retirement is terminated instead of published.
The existing process-group termination remains the mechanism: this does not claim
new supervision for deliberately detached descendants or cancellable OS discovery.
Process cleanup runs off the window lifecycle callback. Configuration generations
are scoped to the owning page; a delayed retirement cannot invalidate a newer one.

Validation: 5,100 frontend tests in 548 files pass, including 73 focused LSP tests.
All 1,509 tests in the full native run pass (three ignored); the final focused
run passes 46 native LSP tests, including the additional real-process cross-window
cleanup test. Types, lint (80 existing warnings), all-target Clippy with warnings
denied, formatting, whitespace, production build, startup graph and size checks pass. Client JS is 2,831,448 compressed bytes, 566 bytes above pass 87; the measured
allowance is 2,831,450 bytes. Startup/terminal budgets are unchanged. These checks
run on macOS arm64; other platform runtime validation remains outstanding.

Logs: /tmp/oarlock-review88-{ai-stability,lsp,frontend-tests,rust-tests,native-lsp,types,lint,clippy,build,dist,size}.log.
Before-fix evidence: /tmp/oarlock-review88-{lsp-before,locations-before}.log.
Existing Git publication, Undo, Windows staged-write/restoration and platform
release blockers remain open. Next non-AI coverage: LSP message ordering and
initialization failures, then fresh editor/navigation and terminal lifecycle paths.
No commit or push.

## Previous pass: 87

| Area | Work in this pass | Status |
| --- | --- | --- |
| Automatic MCP discovery lifetime | Settings reproduction started all 17 configured discoveries and sent no cancellation on unmount | Approved page ownership, exact-request cancellation and a separate eight-discovery native cap implemented |
| Discovery scheduling and recovery | Traced refresh, disable/edit, auth actions and delayed completions | Settings tracks at most 256 current candidates, starts at most eight, cancels obsolete work and offers explicit Retry for failed discovery |
| Metadata HTTP failures | Real local HTTP 503 was accepted as absent metadata; automatic discovery swallowed errors | 5xx/429 fail explicitly, request/parse errors propagate; 404 retains absence behavior |
| Recent probe and network fixes | Reran complete frontend/native suites including endpoint probes, DNS limits and deadlines | Pass on macOS arm64 |

Discovery is separate from endpoint Test probes and interactive sign-in. Native
registration validates the current page before async work; page retirement and
server cancellation prevent later publication under the same registry lock.
Configuration commits cancel affected native probes independently of UI delivery.
Saved global URL/revision/enabled state and project entry trust/identity are checked
before discovery and revalidated before publishing metadata. The frontend repeats
cancellation if it overtakes registration, retains cancelled running capacity until
settlement, and discards stale results. Errors belong to the configuration that
produced them and are dropped when it is removed or edited. No polling/retry timer,
new dependency or automatic failure retry loop was added.

The candidate bound follows the native status-query limit of 256 references. An
excess native start reports busy and offers Retry. This pass does not add per-host
DNS caching, change the five-minute interactive sign-in allowance, or certify all
OAuth token-read/recovery and metadata-parser behavior. Project-file edits are
revalidated at publication; this is not a claim of instantaneous cancellation of
every external filesystem mutation while a network request is already in flight.

Validation: all 5,092 frontend tests in 547 files and 1,507 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Total client JS is 2,830,882 compressed bytes, 1,246 bytes over pass 86;
the measured allowance is 2,830,890 bytes. Startup and terminal budgets are unchanged.
Other platform runtime validation remains outstanding.

Before-fix logs: /tmp/oarlock-review87-{probes-before,metadata-before}.log.
Focused checks: /tmp/oarlock-review87-{probes-after,native-after,metadata-after}.log.
Full checks: /tmp/oarlock-review87-{frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
For comparison, the official [MCP Ruby SDK discovery guidance](https://ruby.sdk.modelcontextprotocol.io/client/authorization/)
also distinguishes unreachable/5xx/429 metadata from absence. The local HTTP tests
are the evidence for Oarlock's fix. No commit or push. Existing release blockers
remain open; next fresh coverage is OAuth token-read failures and metadata parsing.

## Previous pass: 86

| Area | Work in this pass | Status |
| --- | --- | --- |
| Endpoint probe admission | Real HTTP reproduction opened 17 concurrent probe connections outside request limits | Approved separate app-wide limit of eight active probes; excess starts fail visibly |
| Probe lifetime | Hook reproduction showed unmount sending no cancellation | Page-generation ownership plus exact request cancellation on URL change, retest, collapse/unmount and page retirement |
| Upload admission | AI/MCP copied bodies before validating page ownership and capacity | Reserve existing slots before copying; failed body decoding releases ownership |
| Recent fixes | Reran deadline, response handling, DNS and page-generation regressions as part of the full suite | Pass on macOS arm64 |

Probe registration returns before completion. Cancellation that overtakes the start
command is repeated after its admission acknowledgment, using the original request
ID and page generation. Retired pages cannot admit queued work. The native fixture
fills all eight slots, refuses a different window's ninth request, closes the first
window's sockets and verifies capacity recovers. Chat capacity remains separate.
Frontend tests cover late admission, cancellation while page initialization waits,
old completions, retests, changed URLs, unmount and collapsed custom cards. No new
dependency, persistent timer or queued probe workload was added.

Upload admission now precedes decoding and copying. Regression tests verify stale
pages and full capacity reject before body decoding, and malformed admitted bodies
release the reserved slot. This does not bound Tauri's incoming buffers or frontend
body preparation, which occur before this native handoff.

Validation: all 5,078 frontend tests in 545 files and 1,503 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Total client JS is 2,829,636 compressed bytes, 360 bytes over pass 85;
the measured allowance is 2,829,640 bytes. Startup and terminal budgets are unchanged.
Other platform runtime validation remains outstanding.

Before-fix logs: /tmp/oarlock-review86-{probe-ui-before,probe-native-before}.log.
Focused checks: /tmp/oarlock-review86-{probe-ui-after,probe-native-after,probe-final,upload-after}.log.
Full checks: /tmp/oarlock-review86-{frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
No commit or push. Existing release blockers remain open. Automatic MCP OAuth
metadata-probe ownership/admission and remaining HTTP consumers are follow-up
coverage; endpoint Test coverage does not certify those separate paths.

## Previous pass: 85

| Area | Work in this pass | Status |
| --- | --- | --- |
| DNS and request regressions | Reran the full native suite, including bounded resolver work and page-generation ownership | Pass; the approved DNS limits remain unchanged |
| Non-streaming deadlines | Real HTTP redirect chain exceeded the timeout because every hop restarted it | Approved total deadlines implemented: probes 5 seconds, images 20 seconds, OAuth HTTP operations 30 seconds |
| Endpoint connection Test | Reproduced an old URL's successful probe appearing against a changed URL draft | Results belong to the exact draft identity and latest invocation; unmounted cards ignore completion |
| Response descriptions | Reproduced an empty-body 503 reaching the SDK with an empty status description | AI/MCP metadata carries the canonical HTTP reason through Response construction |

The shared deadline encloses DNS queueing/resolution and the entire HTTP operation,
including redirects and body consumption. Probes finish at headers. Expiry drops
owned network work; a running system lookup retains its DNS permit until the OS
returns. Interactive OAuth still allows five minutes, and AI/MCP event streams
keep their existing streaming lifecycle. Tests cover combined phases, expired work,
resource release, a real delayed redirect chain and a real stalled response body
whose socket closes at expiry. No dependency or persistent timer was added.

Probe results are scoped to URL identity, including changing away and back, and
invocation order. This does not yet cancel the native probe when its Settings card
closes or changes URL. Status descriptions are canonical HTTP reason phrases, not
custom server reason text. Full browser Fetch parity remains outside certification.

Validation: all 5,072 frontend tests in 544 files and 1,500 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Total client JS is 2,829,276 compressed bytes, 124 bytes above pass 84;
the measured allowance is 2,829,280 bytes. Startup and terminal budgets are unchanged.
These are macOS arm64 results; other platform runtime validation remains outstanding.

Before-fix evidence: /tmp/oarlock-review85-{deadline-before,ping-before,response-before}.log.
Focused checks: /tmp/oarlock-review85-{deadline-after,deadline-core,response-after}.log.
Full checks: /tmp/oarlock-review85-{frontend-tests,rust-tests,types,lint,clippy,build,dist,size}.log.
No commit or push. Existing Git publication, Undo, Windows filesystem and platform
release blockers remain open. Probe lifetime/admission and remaining HTTP consumer
behavior are follow-up coverage, not an assertion that those paths are bug-free.

## Previous pass: 84

| Area | Work in this pass | Status |
| --- | --- | --- |
| Page generations | Reran the shared frontend and native lifecycle regressions | Pass; no new generation policy |
| DNS ownership | Controlled blocking-resolver reproduction retained 17 workers after their HTTP requests were cancelled | Approved shared limit implemented: 8 active, 32 queued, 10-second DNS caller deadline |
| Upload cancellation | Reproduced an upload source left open when abort occurred just after page-token delivery | Fixed the gap around the initialization await; pre-aborted uploads also release their owned body |
| Response headers | Reproduced the first of two authentication challenges disappearing during native serialization | Preserve header pairs through AI/MCP IPC, including separate Set-Cookie fields |

DNS uses the existing system lookup and Tokio blocking pool. Running lookups own
permits independently of their callers, so cancellation cannot free capacity while
the OS still works. Waiting callers are bounded and cancelled queued jobs do not
start. The deadline covers queue wait plus resolution, including the race in which
a slot becomes free at expiry. Literal addresses still bypass DNS, and address
classification/pinning are unchanged. The controlled reproduction injects a held
resolver closure at the production blocking boundary; it does not modify system
DNS or claim an OS resolver can be killed. No dependency, DNS cache or dedicated
worker pool was added.

Tests cover capacity/overflow, cancelled running and queued work, deadline expiry,
permit release at the deadline, resolver failure/panic and recovery. Fetch tests
cover cancellation around token delivery and repeated headers through Response.
The native MCP sign-in marker still overrides any same-named server field.

Validation: all 5,067 frontend tests in 543 files and 1,495 native tests pass
(three native tests ignored). The focused native network suite has 79 passing
tests. Types, lint (80 existing warnings), all-target Clippy with warnings denied,
production build, startup graph, unchanged size budgets, formatting and whitespace
checks pass. Logs: /tmp/oarlock-review84-{types,lint,frontend-tests,clippy,
rust-tests,build,dist,size}.log. These are macOS arm64 results only; Windows,
Linux and macOS Intel runtime validation remain outstanding.

Before-fix evidence:
/tmp/oarlock-review84-{dns-before,upload-before,headers-before}.log.
Focused passing checks: /tmp/oarlock-review84-{page-regressions,request-after,
headers-after,network-after}.log. No commit or push. Existing release blockers
remain open; request/response contract parity is not exhaustively certified.

## Previous pass: 83

| Area | Work in this pass | Status |
| --- | --- | --- |
| Model discovery and preview images | Reran response limits/deadlines, exact-load leases, hide/close cancellation and native image socket cleanup | Regressions pass |
| Native stream backpressure | Reproduced server bytes resetting a stalled consumer's 120-second timeout | Fixed by retaining the same credit wait across network arrivals; no new timeout policy |
| Fetch cancellation reasons | Reproduced caller TimeoutError/custom reasons becoming generic AbortError | Fixed before admission, during request-body reads and while waiting for response headers/body |
| Queued request admission | Controlled native scheduling reproduces registration after window cleanup | Approved page-generation boundary implemented; queued stale work and stale cancellation/credit are rejected |
| Adjacent request handling | Traced binary upload, metadata, credit delivery, native request registration and blocking DNS lookup lifetime | Bounded inspection; full fetch parity and DNS worker shutdown are not certified |

The stream timeout fix keeps its credit-wait future pinned on the stack while
network chunks fill the next packet. Only a credit notification can renew the
consumer deadline. It adds no allocation, dependency or recurring task. The
cancellation fix preserves AbortSignal.reason and forwards it to a cancelled
request-body reader; default AbortError behavior remains covered.

After approval, AI, MCP and preview-image requests now require a native-issued
page generation. Native retirement and request admission share one lock; retirement
invalidates the token before cancelling the registered requests. Cancel and credit
commands also require that same generation, so delayed old-page cleanup cannot
act on replacement requests. The original queued-admission reproduction now passes.

Native delivers the token into the loaded document at PageLoadEvent::Finished,
instead of exposing a token-query command that could itself be delayed across a
reload. The frontend waits abortably, fails visibly after 30 seconds if delivery
never arrives, and cancels an unowned upload body if initialization fails. No new
request starts after its caller cancels while waiting. Existing request limits,
image leases, idle cache limits and SSRF checks remain in force.

Regressions cover queued stale admission, wrong-window tokens, retirement racing
registration, cancellation before the first I/O poll, stale cancel/credit commands,
missing initialization and late delivery. An isolated real Tauri webview probe
uses the production lifecycle handler and frontend initialization module; it
verifies delivery, reload rotation and refusal of the old generation without
opening app stores or credentials. Reproduce it with the commands at the top of
src-tauri/examples/network_page_probe.rs. It is a bootstrap/reload smoke test, not
a complete end-to-end test of every HTTP route or platform.

Validation: all 5,064 frontend tests in 543 files and 1,489 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup graph, size, formatting and whitespace
checks pass. Total client JS is 2,829,152 compressed bytes, 537 bytes above pass 82;
the measured allowance is 2,829,160 bytes and the size check passes. Startup and
terminal bundles stay within their existing budgets. No dependency or per-request
token-query IPC was added. Initialization timers/listeners exist only while a
request is waiting for native delivery. Logs:
/tmp/oarlock-review83-{types,lint,frontend-tests,clippy,rust-tests,build,dist,size}.log.
The real macOS webview bootstrap/reload probe also passes:
/tmp/oarlock-review83-webview-probe.log. These are macOS arm64 results; Windows,
Linux and macOS Intel runtime validation remain outstanding.

Before-fix logs:
/tmp/oarlock-review83-{timeout-before,reasons-before,admission-before}.log.
Focused passing checks: /tmp/oarlock-review83-{flow-after,reasons-after,consumers,
generation-native,generation-front}.log.
No commit or push. Existing release blockers remain open. Blocking DNS worker
shutdown and remaining request/response contract parity are the next fresh review
targets; this pass does not certify them.

## Earlier pass: 82

| Area | Work in this pass | Status |
| --- | --- | --- |
| Redirect/proxy fixes | Reran the 64 native network tests, including local HTTP fixtures | Regression checks pass |
| Model discovery responses | Reproduced oversized and stalled response bodies | Approved limits implemented: 4 MiB, 2,000 entries, 1,024 UTF-16 code units per ID, 30-second total deadline; explicit errors |
| Preview image ownership | Reproduced stale failed cleanup revoking a successful retry | Approved exact-load leases, hide/close release, last-consumer cancellation and window cleanup implemented |
| Preview image retention | Reproduced three unused 12 MiB blobs retained | Approved 32 MiB idle encoded-blob budget implemented alongside 32-entry cap; active consumers protected |
| Preview image URL handling | Reproduced valid uppercase HTTPS URLs showing the failure placeholder | Case-insensitive scheme matching fixed |

All four original resource/lifetime reproductions now pass. Additional tests
cover misleading response lengths, error bodies, split UTF-8, boundary values,
stalled headers/body, caller cancellation and late responses. Image regressions
cover shared consumers, repeated releases, late results, hide/show and document
changes, native registration errors and cancellation overtaking registration.
A real local HTTP test verifies that cancelling window-owned work closes a stalled
response socket; another verifies that a second window remains unaffected.

The image command registers ownership synchronously and delivers one binary
channel result. Cancellation is retried after acknowledgment if it overtook
registration. Page reload and window destruction cancel registered requests.
No new dependency or recurring worker was added. The idle budget counts encoded
blobs, not decoded image/GPU memory. Active image memory and concurrent downloads
retain their previous policy. Broader request admission across page replacement,
DNS resolver shutdown and full fetch-contract compatibility remain unverified.

Validation: all 5,054 frontend tests in 541 files and 1,483 native tests pass
(three native tests ignored). Types, lint (80 existing warnings), all-target Clippy
with warnings denied, production build, startup dependency graph, formatting and
whitespace checks pass. Total client JS is 2,828,615 compressed bytes, 2,176 bytes
above the last recorded measurement; the measured allowance is 2,828,620 bytes.
Startup and terminal bundles remain within their existing budgets. The size check
passes with that explicit allowance adjustment. Logs:
/tmp/oarlock-review82-{types,lint,frontend-tests,clippy,rust-tests,build,dist,size}.log.
These are macOS arm64 results, not Windows/Linux runtime or release-bundle
certification. No commit or push. Existing release blockers remain open.

Before-fix evidence remains in
/tmp/oarlock-review82-{consumers-before,image-budget-before}.log; focused results
are in /tmp/oarlock-review82-{consumers-integration,native-images-after}.log.
Next fresh scope: native fetch cancellation/admission and request/response
contract parity. This pass does not reopen completed consumer fixes without new
evidence; unresolved Git publication and platform blockers remain separately tracked.

## Earlier pass: 81

| Area | Work in this pass | Status |
| --- | --- | --- |
| Startup recovery and packaging | Bounded follow-up of the prior changes; 27 window lifecycle/recovery tests and nine packaging tests | Regression checks pass; no broader packaging or platform certification |
| Native AI redirects | Traced request bodies, headers, cached clients and redirect validation; reproduced a cross-origin POST forwarding a synthetic prompt and API-key header | Fixed after approval: original scheme, host and port are mandatory on every hop |
| Guarded native proxy routing | Reproduced inherited HTTP proxy routing around a pinned destination in an isolated child process | Fixed after approval: all four client profiles disable inherited/OS proxies |
| Adjacent network paths | Inspected address classification, stream ownership/credit, image redirects, MCP origin checks and OAuth fetch policy, plus frontend transport/callers | Shared routing fix applies; these adjacent lifecycles are not exhaustively certified |

The redirect reproduction used two local servers and synthetic data. Tests now
refuse cross-origin 301/302/303/307/308 redirects before the second server receives
a request, report a useful error, and retain bodies/headers for same-origin 307s.
Unit checks cover host, port, scheme, userinfo and IPv6 cases. Scheme changes include
HTTP-to-HTTPS upgrades: users must configure the final endpoint URL explicitly.

A separate local proxy fixture returned a different response despite the configured
resolver pin. The regression now checks direct routing for Stream, Ping, Fetch and
Mcp in a subprocess with HTTP_PROXY/http_proxy set, without mutating the test
runner's environment. This covers the common constructor used by native AI, local
probes, OAuth, MCP and Markdown images. Windows OS-proxy behavior was not executed
on this host. Proxy-only networks are an explicit unsupported configuration for
these routes; built-in browser-provider requests keep webview networking behavior.
No new dependency, worker, timer, IPC round trip or client-cache dimension was added.

Validation: 5,035 frontend tests in 539 files; 1,480 native tests (three ignored);
types, lint (80 existing warnings), all-target Clippy with warnings denied,
formatting and whitespace checks pass. Native network suite: 64 tests. Evidence:
/tmp/oarlock-review81-network-{before,after}.log and
/tmp/oarlock-review81-{types,lint,frontend-tests,clippy,rust-tests}.log. No commit or push.

Next fresh scope: network consumers, particularly model-list response bounds and
preview-image request/cache lifetime. Request admission across page replacement,
DNS cancellation and full fetch-contract compatibility remain follow-up targets.
The carried-forward release blockers below are still unresolved.

## Earlier pass: 80

| Area | Work in this pass | Status |
| --- | --- | --- |
| Startup window restoration | Reproduced source deletion after a failed adoption; implemented the approved recoverable migration, strict reads and startup failure handling | Fault-injection and real ACL-denial regressions pass on macOS arm64 |
| CLI release packaging | Reproduced wrong cross-compilation target and missed/custom target-directory output | Uses Tauri's target and Cargo's reported output directory; script regressions and a real local CLI build pass |
| macOS Git helper packaging | Reproduced documented local build failing without an Apple signing identity; implemented the approved local/distribution policy | Real ad-hoc helper build/signature verification passes; distribution requires a team identity and final bundle verification |
| Updater | Inspected configuration, capability removal, hook/dialog and release workflow | Deliberately disabled; it was not enabled or certified as a working update path |

The migration durably journals spaces, scrollback, active-chat metadata and the
window registry, then publishes the registry last. Displaced state stays in the
private journal until commit. Interrupted operations resume on relaunch; corrupt
or unexpectedly changed state stops startup with a recovery error. Successful
cleanup retires the journal before deleting backups. Failed startup teardown does
not discard saved windows. Ordinary launches do not rewrite the registry.

Tests interrupt all eight backup/publication renames and the commit marker. They
also cover the original ACL-denied rename, corrupt state/journal, changed state,
absent source/active-chat state, partial commit markers, committed-journal cleanup,
source symlinks and a read-only ordinary startup. Startup errors propagate through
Tauri setup and are logged with recovery guidance; a recovery wizard was not added.

Windows adoption intentionally refuses until private staging and metadata
preservation are supported. Linux code has not been runtime-validated here. No
signed distribution or full packaged-app smoke test was run; the helper remains
executionReady=false. This pass adds no recurring worker, timer or IPC to startup.
Migration hashes stream scrollback content only during adoption/recovery.

Validation: 5,035 frontend tests in 539 files; 1,475 native tests (three ignored);
types, lint (80 existing warnings), Clippy with warnings denied, formatting and
whitespace checks pass. Evidence: /tmp/oarlock-review80-*.log. No commit or push.

Pass 81 followed this pass into native HTTP/network boundaries and their callers.
Production Git execution/publication and the other release blockers below remain
unfinished; passing this focused startup/packaging pass does not resolve them.

## Earlier pass: 79

| Area | Work in this pass | Status |
| --- | --- | --- |
| Atomic replacement metadata | Bounded follow-up of capture, apply, verification, size limits and shared callers; existing regressions included in full validation | Regression review, not new subsystem coverage |
| Git metadata authorization | Bounded follow-up of explicit authorization, linked-worktree backlinks and discovery checks; existing regressions included in full validation | Regression review; isolated execution still incomplete |
| Language-server integration | Native stdin/termination, frontend transport, startup admission; inspected adjacent session lifecycle | Four reproduced defects fixed; focused pass complete, broader lifecycle not certified |

Pass 79 fixed:

- Stop waiting on a full language-server stdin pipe before terminating the server,
  blocking the native UI-thread command.
- Pending language-server starts bypassing the existing four-session admission cap.
- Malformed configuration request parameters throwing from the transport callback.
- Buffered and late messages reaching listeners after their transport closed.

Validation: 5,026 frontend tests in 537 files; 1,464 native tests (three ignored);
types, lint (80 existing warnings), Clippy with warnings denied, formatting and
whitespace checks pass. Windows explicit Job Object termination has a platform
regression test but was not run on this Mac. No new architecture policy was needed
for these existing-contract fixes. No commit or push was made.

Pass 80 followed this pass into startup, updater and release configuration.
LSP configuration changes during startup, window ownership, native send ordering
and exceptional process cleanup remain follow-up review targets, not certified
behavior from this focused pass.

## Historical coverage and limits

Previous passes inspected AI requests and cancellation, credentials/OAuth, native
settings stores, composer imports and voice, document saves/recovery, file watches,
source control and Git publication. Those areas have findings and regression tests;
none should be described as exhaustively reviewed. Recent passes concentrated on
filesystem and Git changes, including defects in review-generated fixes.

The terminal has its own earlier audit documents, but this pass has not repeated
that audit. Remaining network consumers, platform-specific paths and the rest of
the UI still need explicitly recorded review coverage. Packaging/updater received the bounded
pass 80 inspection above, not end-to-end release certification.

## Release blockers carried forward

- Complete and validate isolated Git execution and candidate publication. The
  current helper advertises executionReady=false; the live runner's during-command
  ownership race is not solved by preflight or postflight checks.
- Complete atomic Undo protection for HEAD/ref changes during publication.
- Implement supported Windows staged writes; they currently fail safely. Startup
  adoption now also refuses when private metadata-preserving staging is unavailable.
- Validate Linux and Windows behavior and macOS Intel builds/runtimes. Local passing
  results are macOS arm64 evidence only.

## Review discipline

Each pass records its actual subsystem scope, reproduced failures, fixes, checks and
remaining limitations. Newly approved architecture work is implementation work,
not proof of additional review coverage. Revisit a subsystem for a concrete new
failure or unresolved release requirement, not merely to repeat passing checks.
