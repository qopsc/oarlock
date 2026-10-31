# PR #1 coverage-first review ledger

Created: 2026-10-28. Coverage-first phase; sections 01–30 and F1–F5 complete; the three remaining auxiliary rename-source entries are reviewed at checkpoint 26. Breadth is complete. The R044/R084/R086 depth validation is complete; AP002 is implemented locally with platform validation outstanding. AP001 and AP003 remain deferred.

PR: https://github.com/qopsc/oarlock/pull/1
- Base: `5502f826a6476556182ddbe1466ec2ba94c0fd47`
- Published head and local HEAD: `577ccc9ed0ffc497be4b2ee15b42d2a0592c03ac`
- GitHub changed-file inventory: **1251 files**, all individually listed below.
- Local supplemental inventory: **500 additional paths** (uncommitted/untracked, not claimed to be in the published PR). Includes branding assets; their provenance is not assumed.
- Published paths with local changes are labelled `PR+LOCAL`; additional local paths are labelled `LOCAL-ONLY`.
- Review the current working copy for an existing path; review the removed side for a deleted path. Do not silently substitute old PR code for local fixes.
- Binary/generated/deleted files remain in coverage: record the appropriate inspection method, not a claim of line-by-line source review.
- This ledger is administrative and is not counted as a product file. Directories below group every listed file; directory counts are not extra files.

## Rules and stopping points

- Review TODO sections in numbered order, once each. DONE means one breadth pass, not certification or exhaustive validation.
- User unfroze all areas at checkpoint 14 authorization (2026-10-28). F1–F5 retain their stable section IDs after section 30. The three remaining old rename-source entries were completed at checkpoint 26 under the then-current ten-minute authorization. A subsequent authorized depth batch covered R044, R084 and R086. The user approved AP002, which is implemented locally with platform validation outstanding; AP001 and AP003 remain deferred. Stop before another depth batch.
- Historical frozen coverage gaps remain recorded; unfreezing does not reopen DONE sections. Review formerly held implementations only in their assigned sections. K001 remains log-only as explicitly requested.
- Severity: BLOCKER = incorrect behavior, data loss, security or crash; MAJOR = likely bug or significant maintainability problem; MINOR / NIT = small cleanup, naming or style.
- Fix only a demonstrated BLOCKER confined to its section and under approximately 50 lines, with a regression test. Log everything else without fixing.
- Any new abstraction, data-model change, public/native interface change or cross-section change is an ARCHITECTURE PROPOSAL: record problem, options and recommendation, then stop for an answer. This overrides the small-fix allowance.
- After every two completed sections, or any architecture proposal, stop and report counts, new BLOCKER/MAJOR findings, fixes/files/tests and questions; wait for the user.
- Never reopen a DONE section. Later discoveries become new findings without reopening or rework.
- Record elapsed review time and source edit counts. Stop before a third edit to any source file, or at the current user-authorized time cap. The latest explicit ten-minute cap supersedes the historical longest-section ceiling. No depth investigation was authorized during the breadth phase.
- Routine ledger updates are administrative; source edit counts start with this phase. Historical edits are not counted as new edits.
- No cleanup rewrites. AI is now eligible in F1 under the same breadth rules. No commits or pushes requested.

## Coverage summary and ordered sections

- **35 DONE / 0 TODO / 0 FROZEN sections.**
- **1751 reviewed / 0 TODO / 0 FROZEN files** (published + local supplemental).
- **6/6 auxiliary rename-source entries reviewed**; the last three were inspected at checkpoint 26. Old names are not additional unique files.

| Section | Status | Area | PR files | Local-only files | Total |
| --- | --- | --- | ---: | ---: | ---: |
| 01 | DONE | Updater | 4 | 0 | 4 |
| 02 | DONE | OS privacy and permissions UI | 22 | 0 | 22 |
| 03 | DONE | CLI and external control | 9 | 1 | 10 |
| 04 | DONE | Shortcuts and native menus | 16 | 1 | 17 |
| 05 | DONE | Explorer and file navigation | 22 | 4 | 26 |
| 06 | DONE | Project search, command palette and sidebar | 23 | 6 | 29 |
| 07 | DONE | Tabs and spaces | 35 | 2 | 37 |
| 08 | DONE | Application startup, windows and quit | 30 | 12 | 42 |
| 09 | DONE | Workspace authorization and environment | 9 | 3 | 12 |
| 10 | DONE | Filesystem operations and document saves | 7 | 11 | 18 |
| 11 | DONE | Filesystem watchers | 4 | 0 | 4 |
| 12 | DONE | Editor documents, recovery and diffs | 28 | 22 | 50 |
| 13 | DONE | Editor search and Vim dependencies | 5 | 50 | 55 |
| 14 | DONE | Language servers | 20 | 9 | 29 |
| 15 | DONE | Git backend and isolated execution | 10 | 21 | 31 |
| 16 | DONE | Source control and Git history UI | 24 | 9 | 33 |
| 17 | DONE | Native PTY and shell integration | 21 | 10 | 31 |
| 18 | DONE | Terminal sessions and transport | 49 | 0 | 49 |
| 19 | DONE | Terminal input, links, clipboard and drops | 27 | 20 | 47 |
| 20 | DONE | Terminal blocks, search and selection | 20 | 9 | 29 |
| 21 | DONE | Terminal WebGPU rendering | 23 | 0 | 23 |
| 22 | DONE | Terminal WebGL rendering | 12 | 0 | 12 |
| 23 | DONE | Ghostty model and WASM package | 30 | 0 | 30 |
| 24 | DONE | Fonts, glyphs and typography | 72 | 0 | 72 |
| 25 | DONE | Non-storage appearance, theme formats and styling | 62 | 0 | 62 |
| 26 | DONE | Ordinary settings and shared UI utilities | 49 | 8 | 57 |
| 27 | DONE | Build, dependencies, CI and distribution | 37 | 0 | 37 |
| 28 | DONE | Diagnostics and review/test tooling | 69 | 12 | 81 |
| 29 | DONE | Documentation and project policies | 35 | 2 | 37 |
| 30 | DONE | Branding and image assets | 55 | 158 | 213 |
| F1 | DONE | AI, agents, MCP, skills and supporting request/credential code | 340 | 97 | 437 |
| F2 | DONE | Preview code and fixes | 51 | 11 | 62 |
| F3 | DONE | XML and language override code | 2 | 12 | 14 |
| F4 | DONE | Theme storage, transactions and snapshots | 10 | 4 | 14 |
| F5 | DONE | Shared integration files (formerly held as frozen) | 19 | 6 | 25 |

## Findings register

| ID | Severity | Section | Finding | Disposition |
| --- | --- | --- | --- | --- |
| R001 | MAJOR | 01 | Dormant ARM Linux bug: `UpdaterDialog.tsx:18–24` generates only `amd64.deb` / `x86_64.rpm` installation commands, with no architecture selection. An ARM user would be instructed to install the wrong package after updates are enabled. | Source-confirmed; unreachable while `UPDATES_ENABLED=false`. Log only; no fix. |
| R002 | MAJOR | 01 | Dormant failure-feedback bug: `useUpdater.ts:149–150` stores install/download errors, but `UpdaterDialog.tsx:51–57` renders nothing for `error`. A failed update closes its prompt without showing the failure or a retry action. | Source-confirmed; unreachable while updates are disabled. Log only; no fix. |
| R003 | MINOR | 02 | `MacPrivacySettings.tsx:88–91` and `fileErrors.ts` only log failed attempts to open System Settings. The user receives no visible explanation when the button fails. | Source-confirmed; section 02 complete. Log only; no fix. |

| R004 | MAJOR | 03 | An explicit caller pane that no longer resolves silently falls back to the active window/space: `control.rs::forward_to_frontend` clears an unresolved caller; `context.ts::resolveControlContext` similarly selects the active tab when a caller pane is missing. A delayed command from a closed pane can therefore open in an unrelated space. | Source-confirmed fallback; no end-to-end reproduction or change. Log for later policy/depth review. |
| R005 | FIXED | 03 | A late frontend reply could complete a different request after caller ID reuse. | Fixed in `5d700b9`: server-issued monotonic UI request IDs are never reused within a process, socket IDs remain caller-visible, replies are bound to the target window, and stale/duplicate/unknown replies are dropped and logged. Regression coverage includes timeout, reused slot, duplicate, wrong window and counter exhaustion. |

| R006 | BLOCKER | 04 | Settings omits all three space shortcuts: `SHORTCUT_GROUPS` lacked the existing `Spaces` group, while `ShortcutsSection` renders only groups in that list. Users could not view, search, rebind or clear `space.next`, `space.prev` or `space.overview` there. | Incorrect behavior under the user’s severity rubric. FIXED within section: one production line adds the existing group; 10 test lines cover all three missing entries. Regression failed before the fix and passed after. |
| R007 | MAJOR | 04 | Native macOS New Window and Close Tab accelerators remain fixed at Cmd+Shift+N / Cmd+W in `app_menu.rs`, while Settings permits clearing/rebinding `window.new` and `tab.close`. Neither appears in `MenuAccelerators` or `menuShortcutPlan`, so updating shortcuts cannot update those native menu equivalents. | Source-confirmed mismatch; actual event routing after customization was not exercised in a native window. Log only; no fix or new design in this breadth pass. |

| R008 | MAJOR | 05 | Explorer search does not subscribe to workspace environment: `ExplorerSearch.tsx:130–160` samples the environment only when a query/root/hidden-setting dependency changes. Switching between environments with the same root path can leave the previous environment’s results visible; selection passes only the path. | Source-confirmed dependency/identity gap; requires live navigation reproduction in depth phase. Log only. |
| R009 | MAJOR | 05 | Explorer delete confirmation retains a path-only `menuTarget` across root/environment changes, while confirmation invokes the current `tree.deletePath` closure (`FileExplorer.tsx:315–320,1053–1054`). Batch confirmation similarly reads the current selection rather than the selection initially confirmed. | Potential destructive stale-context/selection action if the menu survives navigation; component remount/menu dismissal behavior not reproduced. Log only; no lifecycle redesign. |
| R010 | MAJOR | 05 | Concurrent directory refreshes in `useFileTree.ts:189–263` share a scope generation but have no per-directory request ordering. An older listing finishing after a newer refresh can restore stale entries until another refresh. | Source-level out-of-order completion risk within one unchanged workspace. No controlled race test in this breadth pass; log only. |

| R011 | MAJOR | 06 | Native content search caps file size and match count, but retains each entire matching line (`grep.rs::search_tree`) with no total response-byte bound. A sidebar search can retain 1,000 near-5-MiB single-line matches, approaching 5 GiB before serialization/UI copies. | Source-level resource-exhaustion risk; no large-allocation reproduction attempted. Log only; resource policy/design belongs to depth review. |
| R012 | BLOCKER | 06 | `mru.ts::read` accepts JSON `null`, primitives, arrays and invalid timestamp values as a ranking map. Null crashes ranking during palette render; primitives can throw while recording a selection before its command executes. | Reproduced with unit tests: five invalid-data cases failed before correction. FIXED with local shape/value validation using the existing empty-map fallback; six regression cases added, all five original tests retained. No model/interface/abstraction change. |
| R013 | MAJOR | 06 | With all 16 supersession keys busy, `Supersede::begin` returns an untracked ticket. Another query with the same overflow key gets a different counter, so it cannot supersede the earlier work. The table cap therefore drops the latest-query-wins guarantee for additional active channels/windows. | Source-confirmed fallback, also explicit in the existing overflow test; the newer-overflow-query interleaving was not separately executed. Log only; no admission/cancellation redesign in this pass. |

| R014 | MAJOR | 07 | `useSpacePersistence.ts::flush` records its last-written snapshot before `saveState` succeeds and discards failures with `Promise.allSettled`. An identical later flush skips the failed write and resolves successfully, including the explicit close flush. | Source-confirmed failure/retry gap; persistence-failure reproduction and durability policy left for depth. Log only. |
| R015 | BLOCKER | 07 | `planRestoreGrants` deduplicated a folder globally before deciding which WSL space would receive it. Two spaces using the same distro/folder could leave the active space ungranted, or leave a second inactive space with no grant when activated. | FIXED locally: deduplicate immediate grants together and deferred grants per existing space owner. Three regression cases cover each active WSL space and both spaces initially inactive; all failed before the fix. Existing interfaces, data model and grant timing retained. |
| R016 | MAJOR | 07 | `useTabs.ts` writes result/disposal variables inside React state updater callbacks, then reads them immediately outside (`closeTab`, `removeTabsForSpace`, `closePaneByLeaf`, `closeActivePane`, `splitActivePane`). A deferred updater leaves the caller seeing empty/default results and can skip explicit session cleanup. | Source-level scheduling risk; no mounted React/PTY reproduction. Log only; no hook/state redesign. |
| R017 | MAJOR | 07 | `useTabs.ts::openCommitFileDiffTab` reuses a tab by repository path, commit and file without checking `spaceId`, unlike the ordinary diff/history openers. Matching paths/commits in another space can select its tab instead of opening in the current space. | Source-confirmed missing space predicate; full UI/environment consequence not reproduced. Log only. |
| R018 | MAJOR | 07 | `SpaceSwitcher.tsx` routes `pointercancel` through `onPointerUp`, which commits an active drag. Cancelling a drag can therefore move a tab/reorder a space instead of abandoning the operation. It also lacks close/unmount drag cleanup for body selection suppression. | Source-confirmed event wiring; native pointer-cancellation/close reproduction deferred. Log only. |

| R020 | MAJOR | 08 | Bulk tab-close confirmation records dirty tab IDs, not buffer revisions. `confirmCloseMany` awaits hazard evaluation and `hasNewCloseManyHazards` only checks for newly dirty IDs; newer edits to an already-confirmed dirty file during that wait do not require confirmation again. | Source-level data-loss risk; no mounted asynchronous reproduction. Log only; no document/confirmation model change in breadth review. |
| R021 | MAJOR | 08 | `QuickTerminalApp` increments the pane key immediately on shell exit and renders its replacement with `visible` always true while hiding the native window. This does not implement its documented wait-until-next-show lifecycle and can start replacement work while hidden. | Source-confirmed immediate remount; actual PTY respawn/resource behavior needs section-18/depth validation. The existing test mocks the pane and checks replacement/disposal only. Log only; no cross-section investigation. |

| R022 | MAJOR | 09 | Frontend `authorize.ts` caches success indefinitely by requested path, while native authorization grants the resolved path. If a symlink is retargeted and the user explicitly opens it again, cached success suppresses the new native grant; access to the new target can remain refused until reload/cache eviction. | Source-confirmed mismatch between requested and resolved identity; no live symlink/UI reproduction. Log only. |
| R023 | MAJOR | 09 | `wsl_path_to_host` maps every `/mnt/<letter>` path directly to the host drive without checking the distribution's actual mount. With automount disabled or a different filesystem mounted there, filesystem actions can target a different file from the one the shell sees. | Source-confirmed unconditional mapping; custom-mount scenario not run on Windows/WSL. Log only; no mount-resolution design or interface change. |
| R024 | MAJOR | 09 | WSL discovery/home/shell probes use blocking `Command::output()` without timeout or cancellation. A stalled WSL service or helper can leave loading/startup requests and blocking workers pending indefinitely; repeated refreshes can accumulate work. | Source-level lifetime/admission risk; no stalled WSL reproduction on macOS. Log only; no lifecycle redesign. |

| R025 | MAJOR | 09 | `useWorkspaceEnvStore.refreshDistros` has no request ordering: an older refresh completing last can overwrite a newer distribution list/error, and either completion clears `loading` while another refresh remains pending. | Source-level overlapping-request risk; no controlled delayed-response test. Logged during the same section pass; no state/request redesign. |
| R026 | BLOCKER (platform split) | 10 | Ordinary editor/general writes share the unsupported safe-write path: Windows cannot stage/preserve ACLs, and Unix staging only tries the system temporary directory, refusing destinations on another filesystem. This blocks editor saves on Windows and common separate-volume or separate `/home` setups; Linux ACL support also explicitly excludes filesystems outside its allowlist. | R026-W moves to the Windows port and is not a blocker for this release. R026-U retains the separately scoped Unix filesystem/volume limitation; its current behavior and release impact still need validation. Preserve the existing safe-failure policy. |
| R027 | BLOCKER (split) | 10 | Rename/delete/move/copy validate path strings then later operate through them, unlike pinned editor saves. Replacing a validated ancestor with a symlink between authorization and the mutation/read can redirect the operation; the mutation stream mutex only serializes cooperating Oarlock mutations. | REPRODUCED in an isolated project copy. Superseded by R226 (accepted external race) and R227 (guaranteed static-entry protection). The macOS restoration is recorded at the latest checkpoint; R226 is accepted best effort and R227 is covered by the restored static-entry checks. Linux copy is still unavailable. |
| R028 | MAJOR | 10 | `copy_recursive` copies file bytes and basic permissions only; it does not copy ACLs or extended metadata such as quarantine/tags, and directory copies do not preserve source permissions. Explorer copies can therefore lose restrictions/metadata even though editor replacement preserves them. | Source-confirmed omissions; no new ACL/quarantine copy reproduction. Log only; existing content-copy tests do not assert this metadata. |
| R029 | MAJOR | 10 | `fs_open_default` classifies a file before its asynchronous consent/dispatch boundary, then only rechecks authorization and regular-file status before opening it. Replacement or permission/content changes can turn an originally classified document into a program without a new Run prompt, or change the executable that was approved. | Source-level identity/classification gap; native default-handler execution was not exercised. Log only; no consent/launch protocol change. |
| R030 | MAJOR | 10 | `copy_item` stages content under the destination as `.oarlock-copy-*/item`. Copying a normally ignored file such as `.env` inside a Git worktree temporarily gives its contents a different, potentially unignored path, so concurrent terminal Git can capture the staging copy. | Source-level staging/ignore interaction; not reproduced with Git in this pass. Log only; existing outside-worktree staging protections cover saves, not this separate copy path. |

| R031 | MAJOR | 11 | `FsWatchState::release_window` synchronously takes ownership/running/watch-set locks and syncs the backend. `resolve_changes` holds the watch-set lock while statting files, and macOS backend sync probes directories. Slow filesystem work can therefore block window cleanup, despite listing reads being outside the lock. | Source-confirmed lock/IO overlap; no delayed-filesystem lifecycle reproduction. Log only; no cleanup ownership redesign. |
| R032 | MAJOR | 11 | WSL polling treats every `None` listing signature as unchanged, including deletion, access failure, directories over 50,000 entries and recovery from an initially unreadable directory. Without a separately watched file or parent event, these listings can remain stale indefinitely with no health error. | Source-confirmed fallback; existing tests explicitly assert no event for deleted/unknown listings. Actual WSL UI behavior not exercised. Log only; no polling/resource policy change. |
| R033 | MAJOR | 11 | On Windows, `FileStamp` contains only length and modified time. Replacing a file with different same-length content while preserving its timestamp produces an identical stamp, so even a delivered directory event can fail to refresh the editor. | Source-confirmed missing Windows identity/content discriminator; Windows replacement test deferred. Log only; no stamp model change. |
| R034 | MAJOR | 11 | Repository watch preparation authorizes the worktree but follows a `.git` pointer or symlink and lists/stats the resulting metadata directory without separately authorizing it or validating reciprocal linked-worktree ownership. | Source-confirmed native watcher authorization gap; no live unauthorized-directory reproduction. Scope is non-AI watch metadata access only. Log only; no Git authorization redesign. |

R001/R002 are dormant issues, not current release blockers. R005 is an active protocol correctness finding under ID reuse. Earlier review history is not reopened or counted as coverage in this phase.

| R035 | MAJOR | 12 | `NewEditorDialog.submit` captures the root/path but reads `currentWorkspaceEnv()` only after awaiting folder authorization. Navigation during that wait can create the file in another environment; its late success also calls the old completion callback without checking whether the dialog/navigation is still current. | Source-confirmed context/lifetime gap; no mounted navigation reproduction. Log only; no operation-ownership redesign. |
| R036 | MAJOR | 12 | `useEditorFileSync` matches native changed/written events by normalized path alone, without the tab's owning environment. Same-named files in different distributions can trigger each other's reloads. Replacing every backslash with a slash also conflates distinct Unix filenames. | Source-confirmed matching gap; reload is treated as an opaque document operation, so no buffer-loss claim. Log only; no event-contract change. |
| R037 | MAJOR | 12 | `discardBridge.start` has no attempt identity. Overlapping Retry attempts share `client` and `unlisten`; an older completion can install a disposed coordinator as `current`, or an older failure can remove the newer listener. | Source-level async interleaving; overlapping Retry not exercised in a mounted app. Existing tests cover one retry/failure lifetime only. Log only. |
| R038 | MAJOR | 12 | `subscribeDocumentMutations` advances its sequence when events arrive, but an exception applying one queued event abandons the rest of that batch. Retry installs a fresh listener with no replay/reconciliation here; later rename/delete handling can operate on stale document bindings. | Source-confirmed error path; no injected application failure or data-loss reproduction. Log only; recovery semantics need depth review. |
| R039 | MINOR | 12 | `GitDiffPane.countDiffLines` excludes every content line beginning with `++` or `--`, treating it like a patch header, and counts a first-line single `+`/`-` twice. Large-file fallback change totals can be wrong. | Source-confirmed counter logic; no rendered patch fixture added. Log only; cosmetic totals do not justify a fix in this breadth pass. |
| R040 | MINOR | 12 | New File rejects any name containing `..` (including legitimate `a..txt`) as non-relative, yet explicitly accepts absolute Unix paths while the dialog describes relative names. | Source-confirmed validation/help mismatch. Log only; no validation policy change. |

| R041 | MAJOR | 13 | Ordinary regex replacement builds each expanded replacement string before checking its output budget (`regexEvaluation.ts`). The Vim worker's `replace` branch similarly calls native string replacement before `checkResultBudget`. Repeated capture tokens can request far more memory than the advertised 16 MiB limit before rejection. | Source-confirmed post-allocation bound; no large-memory/OOM reproduction attempted. Worker deadlines do not establish a memory bound. Log only; no expansion redesign. |
| R042 | MAJOR | 13 | `async-runtime.js` releases its shared Vim command slot only when a returned promise settles. `invalidate` cancels a regex channel, but cannot settle another suspended callback; the ten-second command deadline is checked only on continuation. An unresolved callback can therefore block commands in every editor indefinitely after cancellation. | Controlled helper reproduction: an unresolved command, invalidate(owner), then input(other) leaves the owner ticket present and the other editor unexecuted. No real Ex callback/app reproduction; frozen adapter/core integration not followed. Log only. |
| R043 | MAJOR | 13 | `safeSearchKeymap` has highest precedence, while `editorKeymap` gives Ctrl+G only high precedence. Combining counted search with the editor keymap puts Find Next's Mod+G first on Windows/Linux, overriding the documented Go to Line chord. Existing editor-keymap tests use the older ordinary search keymap and miss the combination. | Reproduced effective binding order in EditorState; no native Windows/Linux keystroke test. Log only; no frozen editor integration changed. |
| R044 | MAJOR | 13 | The proposed local Vim core package declares `main.d.ts`, which re-exports ignored, untracked `dist` declarations without a generation script. A consumer checking that entry without those artifacts fails. This is not evidence that the actual HEAD clean checkout or current app typecheck is broken. | Conditional finding. Depth: isolated proposed core without `dist` produced two TS2307 errors; HEAD instead declares the registry package, and both local replacement packages are untracked. App adapter declarations do not import core declarations and root `skipLibCheck` is true. See depth checkpoint; no clean installation or app build was reproduced. |

| R045 | MAJOR | 14 | `FrameDecoder::push` caps a parsed Content-Length but never caps unterminated header bytes. A server emitting output without CRLF-CRLF grows the native buffer indefinitely, even though the module claims bounded framing. | Source-confirmed unbounded header path; no large allocation/crash reproduction. Log only; no new header/admission policy. |
| R046 | MAJOR | 14 | On natural server exit, the waiter removes the native registry entry after a 500 ms drain wait without killing surviving helpers. The stdout reader retains an Arc of the session while blocked, preventing Drop cleanup; later frontend kill calls cannot find the removed ID. Thread-start failures after the reader starts have a similar retained-owner risk. Windows job setup failure also explicitly continues without tree ownership. | Source-level process-lifetime gaps; existing tests cover explicit kill/window close, not leader exit with an inherited pipe or thread/job failure. No orphan-process/platform reproduction. Log only. |
| R047 | MAJOR | 14 | Definition/reference replies in `client.ts` validate only that the view's navigation plugin still exists. They do not check request ordering, the requested document snapshot, selection or visibility; an older reply can navigate or replace results after a newer request/edit/tab switch while that view remains mounted. | Source-confirmed lifetime-only check; existing navigation test covers destruction only. No mounted overlapping-request reproduction. Log only. |
| R048 | MAJOR | 14 | LSP URI conversion treats all backslashes as separators and strips `file://` without parsing its authority. A Unix file named `a\b.rs` becomes `a/b.rs`; `file://server/share/main.rs` and `file://localhost/repo/main.rs` become relative paths. | Pure helper reproduction confirmed all three conversions. No native UNC/server integration run. Log only; no cross-platform path-policy change in breadth phase. |
| R049 | MAJOR | 14 | Native shell environment capture is cached forever per shell, including failed captures. Check Again/redetect only clears the frontend binary result, so installing a runtime or changing shell startup PATH cannot refresh that environment until app restart; a transient initial capture failure is equally sticky. | Source-confirmed cache/Retry mismatch in env.rs, detect.ts and the install controls. No actual toolchain installation performed. Log only. |
| R050 | MAJOR | 14 | `LspInstallDialog.checkAgain` can enable its captured server and close the dialog after dismissal or selection of another server. It has no attempt ownership, does not reset checking on successful close/reopen, and leaves checking stuck if saving activation rejects. | Source-confirmed async completion/error/state-reset gaps; no mounted dismissal/failing-save reproduction. Log only. |
| R051 | MAJOR | 14 | `acquireDocExtension` checks the four-session cap before evicting idle sessions of other roots. Once four roots are retained, opening a fifth returns early even when all existing sessions are idle and eligible for eviction; it must wait for the idle shutdown timers. | Source-confirmed ordering of cap check versus eviction. Existing test verifies the cap with in-flight starts, not idle eviction at capacity. Log only. |
| R052 | MAJOR | 14 | `TauriLspTransport.backlog` has no byte/message bound while waiting for the spawn reply or message listener, and native stdout forwarding has no acknowledgment/backpressure gate. The new outbound writer limits do not bound incoming server traffic or early notifications. | Source-level input resource risk; no flood/OOM experiment. Log only; no new inbound scheduling/admission contract. |
| R053 | MAJOR | 14 | Several built-in LSP installation commands are platform-specific (`brew install` for clangd/Zig/Lua and `xcode-select --install` for Swift), but both install UIs offer the same command on every platform with no platform qualification or alternative selection. | Source-confirmed preset/UI mismatch; native Windows/Linux installation not exercised. Log only. |

| R054 | BLOCKER (split) | 15 | The isolated Git worker remains a capability/bootstrap service with `executionReady:false`; the live Git runner remains exposed to repository changes during execution. | Superseded by R228 (accepted external metadata-swap race) and R229 (untrusted executable content remains a guaranteed boundary). Repository admission and defense-in-depth checks have now been extended across the identified native Git entry points; R229 remains open for platform and security-boundary validation. The isolated executor remains incomplete. |
| R055 | MAJOR | 15 | `operations.rs::status_in` decodes the entire porcelain response with `from_utf8(...).unwrap_or("")`. One non-UTF-8 filename makes all changes disappear, reporting an empty status instead of an unsupported-name error; a cap cutting a UTF-8 code point has the same effect. | Source-confirmed decoding fallback; no filesystem reproduction this pass. Log only. |
| R056 | MAJOR | 15 | `utils.rs::is_safe_pathspec` rejects colons, tabs and newlines even on Unix, so names preserved by status/commit-file parsing cannot be staged, discarded or opened in file diffs through those APIs. Commit-file tests explicitly exercise tab/newline names but do not pass them through these actions. | Source-confirmed parser/action contract mismatch; no new runtime reproduction. Log only. |
| R057 | MAJOR | 15 | `process.rs::git_show_text` discards the output-truncated flag, and `operations.rs::log` also parses capped output as complete. A large stored blob can appear as a complete partial file (the diff response only reports patch truncation), while capped history can appear to reach its end early. | Source-confirmed missing truncation handling; large-response scenario not executed. Log only. |
| R058 | MAJOR | 15 | Git read errors are repeatedly converted to missing/empty data: `git_show_text` maps every nonzero exit to Missing, line helpers return empty results, and `list_branches` swallows worktree/branch-list errors. Repository corruption or read failures can appear as removed file contents or an empty branch/worktree list. | Source-confirmed error masking; error-injection reproduction deferred. Log only. |
| R059 | MAJOR | 15 | Undo checks symbolic HEAD before additional Git calls, then updates the originally confirmed ref without rechecking HEAD at publication. Switching branches in that interval still rewinds the original branch, contrary to the approved reject-after-switch policy. | Source-confirmed interleaving, explicitly acknowledged in the source comment; existing test switches before entry, not during publication. Dependent on unfinished publication boundary R054; no new design or fix. |

| R060 | MAJOR | 16 | `useSourceControlPanel.ts` handles `!summary.hasRepo` before `summary.localError`. Refresh failures set `hasRepo:false`, so the normal failure path renders “No repository” and bypasses the error/Retry panel, including privacy-recovery controls. | Source-confirmed producer/consumer branch mismatch; no new mounted failure test. Log only. |
| R061 | MAJOR | 16 | `useSourceControlContext.ts::openGitGraphFromContext` awaits repository resolution and opens its result without checking the initiating space/environment or request generation. Navigation while it waits can open the old result through a stale callback; unlike `useRepositoryTargeting`, this route has no ownership check. | Source-confirmed missing completion guard; live navigation consequence requires depth reproduction. Log only. |
| R062 | MAJOR | 16 | `NestedRepositories.tsx` keys discovery only by `folder` and uses ambient native context. Switching environments with the same folder while this component remains mounted neither clears nor reloads the prior environment’s nested-repository list. | Source-confirmed dependency gap; parent remount behavior during particular navigation sequences not reproduced. Log only. |
| R063 | MAJOR | 16 | Source Control’s file-row Open action replaces every backslash in Git entry names with `/`, and `changeTree.ts` does the same when grouping. On Unix, a literal `a\b.txt` entry is shown under folder `a` and Open targets `a/b.txt`, potentially another existing file. | Source-confirmed path transformation; native UI open not exercised. Log only; no cross-platform path-contract change in this pass. |
| R064 | MAJOR | 16 | `useSourceControl.ts::doRefresh` reuses the previous `repo` object after a successful fresh status read without updating its branch/upstream/detached metadata. Its subsequent auto-fetch decision uses that stale `repo.upstream`, so switching from an untracked branch to one with an upstream can continue suppressing automatic fetch until a full snapshot occurs. | Source-confirmed stale metadata/decision input; no live branch-switch reproduction. Log only. |
| R065 | MAJOR | 16 | `useSourceControl.ts::runRemoteAction` has no in-flight admission guard: it only sets React busy state and clears it when each same-context call finishes. Two calls before the UI disables can overlap; the first completion clears busy state while the other Git action still runs. | Source-confirmed concurrent-call interleaving; ordinary double-click timing not reproduced. Log only; no coordination redesign. |

| R066 | MAJOR | 17 | `pty_open` starts a blocking spawn and inserts its result afterward without revalidating the owning page/window. Close/reload cleanup only removes sessions already registered; a pending startup can register and keep running after that cleanup, with no surviving frontend to close it. | Source-confirmed interleaving; delayed native spawn/window-close reproduction deferred. Log only; no ownership redesign. |
| R067 | MAJOR | 17 | `pty_write`, `pty_resize`, `pty_close` and foreground queries accept a process-wide numeric session ID without checking the calling webview, unlike cwd/drop/presentation operations. Another app window can therefore operate on sessions it does not own if given their ID. | Source-confirmed missing ownership checks; no cross-window IPC reproduction. Log only; native interface changes require separate approval. |
| R068 | MAJOR | 17 | Native input admission bounds queue entries (64), but `pty_write` clones unrestricted raw bodies before waiting and `Session::write` has no byte limit or pending-caller cap. A stalled reader can retain arbitrarily large queued input and additional awaiting callers despite the queue bound. | Source-level resource-exhaustion risk; no large-allocation test attempted. Log only. |
| R069 | MAJOR | 17 | Windows PTY startup attaches its Job Object after the shell is already running and continues on assignment failure. Early descendants can escape ownership, and failure leaves an explicitly unmanaged process tree, so closing the terminal cannot guarantee its children stop. | Source-confirmed ordering/fallback; Windows execution not tested. Shared suspended-spawn helper exists but is not used by the portable PTY path. Log only. |
| R070 | MAJOR | 17 | `proc/capture.rs::collect` returns after its grace deadline but leaves the blocking pipe-reader thread alive until EOF. For ordinary non-cancellable capture calls, descendants retaining stdout/stderr can keep reader threads and capped buffers alive indefinitely; repeated invocations accumulate them. | Source-confirmed lifetime and documented reader behavior; no new orphan-process reproduction. Applies to shared native runner, not a re-review of AI call sites. Log only. |
| R071 | MAJOR | 17 | Scrollback load opens a path with `O_NOFOLLOW` but without `O_NONBLOCK`, then checks whether it is a regular file. A FIFO at the saved-history path blocks before that check while holding the app-wide scrollback gate, stalling other loads/saves/retention. | Source-confirmed open-before-type-check risk for a replaced/special-file entry; no FIFO reproduction this pass. Log only. |
| R072 | MAJOR | 17 | `ensure_utf8_locale` considers any UTF-8 LANG/LC_CTYPE/LC_ALL sufficient and otherwise sets only LANG. A higher-priority `LC_ALL=C` or non-UTF-8 LC_CTYPE still wins, so shells can remain non-UTF-8 despite the function’s guarantee, affecting Unicode input/output. | Source-confirmed precedence mismatch; locale/platform shell behavior not exercised. Log only. |
| R073 | MAJOR | 17 | Windows `cwd::authorize_reported` trusts a terminal’s OSC 7 path without process-cwd verification and returns true even when authorization fails. Arbitrary terminal output can request unrelated workspace grants or install an unusable cwd; the IPC also accepts an environment separately from the session. | Source-confirmed platform trust/failure fallback; Windows exploit/normal-workflow reproduction deferred. Existing behavior logged, no trust-policy redesign. |
| R074 | MINOR | 17 | Hub drain-deadline test mixes a simulated Harness clock with the queue’s real-time exit start. Its strict deadline-before-keepalive assertion failed in the focused suite and passed in isolation, making scheduling delay capable of producing a false failure. | Observed: 186 passed / 1 failed / 1 ignored in first PTY run; exact failed test passed on retry. No production timeout failure inferred and no test-only cleanup made. |

| R075 | MAJOR | 18 | `useGhosttyTerminalSession.ts::respawnGhosttySession` increments generation before awaiting the old PTY close, then unconditionally clears the PTY/initialization slots and starts initialization afterward. Concurrent restarts can let a later restart finish while the earlier close waits; that earlier continuation can then clear the newer session and launch another initialization under the same current generation. | Source-level ordering risk; no mounted delayed-close reproduction. Log only; no lifecycle design or fix in breadth review. |
| R076 | MAJOR | 18 | `BoundedPtyWriter` removes a batch before awaiting its write; on failure it reports an error but schedules the remaining queue again. The session reports that error only to the console, and raw input callbacks also ignore `enqueue(false)`. Users can lose a portion of input while later bytes continue to the program, without a visible failure. | Source-confirmed loss/error-handling paths; no live stalled-reader or partial-command reproduction. Existing tests cover normal ordering and budgets, not write rejection. Log only. |
| R077 | MAJOR | 18 | `terminalScrollbackRestore.ts::preferenceSettings.ready` swallows preference initialization failure, while `restoreEnabled` treats every value except explicit false as enabled. Scrollback operations can proceed from defaults when the saved privacy preference is unavailable, potentially persisting history despite a previously disabled setting. | Source-level readiness/fallback risk; actual application startup with failed preferences was not reproduced, and the settings implementation was not reopened. Log only. |
| R078 | MINOR | 18 | Scrollback save/retention failures are logged and swallowed by `TerminalScrollbackRegistry::write`; `flush` reports only whether it timed out. A completed but failed close-time history save is therefore indistinguishable from success to its caller and has no visible recovery feedback. | Source-confirmed failure reporting limitation; existing test explicitly expects log-and-continue. No new durability policy proposed or implemented. |

| R079 | MAJOR | 19 | Native terminal clipboard capture has no admission cap; macOS/Windows OS reads run on blocking workers without an operation deadline, and image writes decode before taking the shared commit lock. Multiple requests can concurrently retain large pixel buffers; frontend image reads queue without a queue bound or cancellation while waiting. | Source-level resource/lifetime risk; no memory-exhaustion or stalled-OS reproduction. Linux capture has a five-second timer, so that platform is not claimed to lack a deadline. Log only. |
| R080 | MAJOR | 19 | `GhosttyInputController::handleKeyDown` awaits clipboard capture while later keystrokes continue immediately. A slow Paste followed by Enter or typing can deliver those keys first and paste into a changed shell/program context; concurrent pastes also lack an input-order barrier. | Source-level input ordering risk; no live terminal reproduction. Terminal disposal is checked, but does not establish ordering within the surviving terminal. Log only. |
| R081 | MAJOR | 19 | `createTerminalPathDropTarget::dropPath` passes the source environment only to shell insertion; the registered-program drop branch receives raw paths without that environment. A path dragged from another WSL distribution or the host can be interpreted in the receiving program's different filesystem. | Source-confirmed interface omission; program/session implementation remains outside this section and no cross-environment live drop was reproduced. Log only. |
| R082 | MAJOR | 19 | `terminalLinkTargets.ts::joinPath` splits both slash and backslash for every base, including POSIX paths. A valid Unix folder or relative filename containing a literal backslash resolves to another pathname when a terminal link is opened. | Source-confirmed normalization rule; no live filesystem/UI reproduction. Log only; path-platform semantics need depth review. |
| R083 | MINOR | 19 | Terminal file-link opening silently returns on authorization/stat failure and does nothing for WSL directories; local reveal errors are also swallowed. The user receives no explanation for an apparently inactive link. | Source-confirmed failure/unsupported-path feedback gap. No navigation redesign or fix. |

| R084 | BLOCKER | 20 | `pathComplete.ts::pathCompletions` emits file labels as default insertion text and inserts directory names verbatim. Spaces become separate arguments, and shell metacharacters in filenames remain executable syntax. Accepting a crafted completion and submitting it can run command substitutions or additional commands. | Reproduced at the function/shell boundary. Controlled probe: production completion returned `$(printf oarlock_completion_probe)` unchanged; a real POSIX shell evaluated it. No full mounted UI exploit claimed. After approval of AP002, FIXED locally, with mounted GUI and non-macOS runtime validation still outstanding. |
| R085 | MAJOR | 20 | `historyPopover.ts` starts open/refilter fetches without operation ordering, cancellation, destruction checks or rejection handlers. A late open can reopen a dismissed popup; an older refilter can replace newer results, and pending callbacks/timers can run after the editor is destroyed. | Source-level lifecycle and stale-result risks; no mounted deferred-fetch reproduction. Log only. |
| R086 | MAJOR | 20 | Shell path completion takes cwd from the terminal but path style and `fs_read_dir` environment from the window's current workspace. Its request/result has no owning leaf/environment identity. A retained or delayed editor completion can use another environment with the same path, and local Git Bash is classified as Windows syntax by host alone. | Conditional finding: source-confirmed mixed context inputs; no cross-space/Git Bash UI reproduction. After approval of AP002, FIXED locally, with mounted GUI and non-macOS runtime validation still outstanding. |
| R087 | MAJOR | 20 | `ShellInput` reuses one CodeMirror editor across leaves, and `shellEditor.setValue` swaps draft text through ordinary history-recorded document changes. The editor's undo history is not reset or partitioned during retargeting, so Undo can bring another terminal's draft into the current terminal. | Source-level draft-isolation risk based on the installed history extension and unannotated setValue transaction; no mounted multi-leaf Undo reproduction. Log only. |
| R088 | NIT | 20 | History popup footer says `↵ run`, but its Enter handler only replaces the draft and closes the popup; another Enter is required to submit. | Source-confirmed wording mismatch; no cleanup fix under breadth rules. |

| R089 | MAJOR | 21 | `imageLayer.ts::ImageTextureCache.ensure` expands gray/RGB images into RGBA before checking the texture byte budget. An image too large for the 64 MiB cache can therefore allocate and fill a much larger temporary buffer on the UI thread, then be rejected and repeat that work on subsequent updates. | Source-confirmed ordering; no memory-exhaustion reproduction attempted. Shared helper also serves WebGL, but its consumers were not reopened to redesign it. Log only; no resource-policy or architecture changes. |
| R090 | MINOR | 21 | `WebGpuTerminalRuntime.revealAfterPresent` ignores the promise returned by a success-only `.then`. If queue completion rejects, `confirmFrames` begins device recovery but the derived reveal promise still rejects without a handler. | Source-confirmed unhandled-rejection path; no native device-loss reproduction or rendering failure claimed. Log only. |

| R091 | MAJOR | 22 | `WebGlCellRenderer.createImageLayer` permanently retains a rejected module-import promise and leaves `imagesLoading` true, swallowing the rejection. A failed first image-code load leaves Kitty images absent with no visible error or retry for the page lifetime. | Source-confirmed failed-load path; no browser chunk-fetch failure reproduction. Log only; no loading/retry redesign. |
| R092 | MAJOR | 22 | `WebGlCellRenderer.handleContextRestored` clears the recovery timer and marks the context healthy before recreating resources/atlas, with no error handler. A shader/allocation failure there bypasses `onContextFailure` and can leave the pane without a scheduled recovery or visible error. | Source-confirmed exception path from required program/buffer/VAO allocation; no real GPU restoration-failure reproduction. Log only. |
| R093 | MAJOR | 22 | `CustomShaderPass.begin` accepts null texture/framebuffer allocations and never verifies framebuffer completeness after storage/attachment. GPU allocation failure can therefore continue into drawing with an invalid target instead of reaching the renderer's error/recovery path. | Source-level failure-handling gap; no memory-pressure/driver reproduction and no claim of universal driver behavior. Log only. |
| R094 | MINOR | 22 | `compileCustomShader` returns immediately when `createProgram` fails without deleting the two shaders it already compiled. They remain allocated in the retained context until context teardown. | Source-confirmed cleanup omission on the allocation-failure branch; no new test or cleanup fix in breadth phase. |

| R095 | MAJOR | 23 | `oarlock.zig::appendOutput` enforces its reply cap by removing arbitrary leading bytes, including bytes inside an escape sequence, without surfacing an overflow. A response burst exceeding the cap can deliver a truncated protocol fragment and omit earlier replies. | Source-confirmed overflow behavior; no production PTY burst reproduction. Ordinary input slicing reduces exposure; no assertion that normal small queries hit the cap. Log only; no reply-admission policy redesign. |
| R096 | MAJOR | 23 | `GhosttyCoreRuntime.createModel` allocates a model, then applies ligature/scroll/clipboard settings before registering it. If one of those calls throws, only the pending ID is cleared; the new model/instance is not disposed or made reachable through the model registry. | Source-level post-construction failure leak; constructor-internal failure cleanup exists but does not cover these later calls. No allocation-failure reproduction. Log only. |

| R097 | MAJOR | 24 | `fontFeatures.ts::declareInstalled` caches empty results and failed native lookups permanently as null. `installedFamily` never retries that key, so a subsequently installed font or recovered lookup remains unavailable for the same family/features until reload, despite the native scan's rescan policy. | Source-confirmed negative-cache mismatch; no installed-font/UI reproduction. Log only. |
| R098 | MAJOR | 24 | Each distinct font-feature combination adds derived `FontFace` objects to `document.fonts` and process-lifetime maps/sets. There is no eviction or removal when the preference changes, so repeated feature/font edits retain old faces and potentially their loaded font data for the page lifetime. | Source-level unbounded retention; no memory-growth measurement. Log only; no cache ownership redesign. |
| R099 | MAJOR | 24 | `GlyphMap.process` checks its time budget only after at least one glyph resolves. If every attempted glyph returns `GLYPH_DEFERRED`, it drains the entire pending queue in one call, including font checks/load admission, without ever checking the budget. | Source-confirmed scheduling gap; no UI-stall benchmark. Log only; no scheduler change. |
| R100 | MAJOR | 24 | Both bundled-font build scripts delete existing WOFF2 assets before generating replacement segments and update CSS only at the end. A subset/compression/write failure midway leaves missing or partial assets referenced by the old CSS and breaks subsequent builds until recovery/regeneration. | Source-confirmed non-transactional developer-tool failure path; no destructive rebuild attempted. Log only; no publication abstraction introduced. |

| R101 | MAJOR | 25 | `color_scheme.rs::follow/read` subscribes to portal changes and launches an initial asynchronous read without ordering them. An older read reply can apply after a newer SettingChanged signal, restoring an obsolete light/dark choice until another event arrives. | Source-level async ordering gap; Linux portal race not reproduced on macOS. Log only. |
| R102 | MAJOR | 25 | `bgImageStore.ts::deleteBgImage` settles on transaction complete/error but has no abort handler. A transaction aborted without a request error can leave its promise pending indefinitely, unlike the neighboring put operation. | Source-confirmed missing abort settlement; no IndexedDB abort reproduction. Log only. |
| R103 | MAJOR | 25 | Background image import limits compressed file bytes, then fully decodes static images before resizing to 2,560 pixels. It has no decoded-pixel admission bound; a small highly compressed image can require a much larger allocation before the resize limit applies. Animated images also bypass resizing. | Source-level resource risk; no large-allocation/decompression reproduction. Log only; no new image resource policy. |
| R104 | MAJOR | 25 | `minimalToml.ts::parseInlineTable/parseValue` recurse through inline tables without a depth limit (unlike the YAML/plist readers). A deeply nested import within the source-size cap can exhaust the JavaScript stack; repeated slicing/scanning also magnifies work. | Source-confirmed unbounded recursion; no hostile-input UI reproduction. Log only; no parser rewrite. |
| R105 | MINOR | 25 | `getBackdropKind` permanently caches a failed native lookup as `none`, so a transient failure disables native backdrop support for that page even if later settings changes retry applying vibrancy. | Source-confirmed negative caching; no IPC failure reproduction. Log only. |

| R106 | MAJOR | 26 | Formatter overrides still save the whole language map: `EditorSection.tsx::FormatterOverrides` spreads its captured `byLang`, and `store.ts::setEditorFormatterByLang` submits a set rather than a field patch. Two editors changing different language overrides can overwrite each other's updates despite native revisioned preference delivery. | Source-confirmed whole-map replacement/interleaving; no mounted multiwindow reproduction. Log only; no data-model or transaction redesign. |
| R107 | MAJOR | 26 | `history/mod.rs::read_histories` reads each shell history file in full, with additional decoded/string/parsed copies and no file-size or regular-file admission check. Large histories can cause disproportionate memory use; an inherited HISTFILE naming a FIFO can block initialization while holding the history-index lock. | Source-level resource and blocking risk; no large allocation or FIFO experiment. Existing native tests passed. Log only; no new resource policy. |
| R108 | MAJOR | 26 | `CwdBreadcrumb.tsx::CurrentSegmentDropdown` reads the current environment when loading but keys its callback only by path/showHidden, and accepts replies without an attempt identity. Switching between environments at the same path does not refresh an open dropdown; older directory replies can also replace newer results. | Source-confirmed dependencies and unguarded completion; no mounted navigation reproduction or claim of destructive execution. Log only. |
| R109 | MAJOR | 26 | `GeneralSection.tsx::chooseShader` waits for file reading and module loading, then saves without checking whether a newer selection or reset superseded it. An older slow import can overwrite the user's later shader choice or restore a shader after Reset. | Source-level asynchronous interleaving; shader implementation in DONE section 22 was not reopened, and no delayed browser File reproduction was run. Log only. |
| R110 | MAJOR | 26 | Native preferences `persist` replaces the destination with a fresh NamedTempFile without copying or verifying existing permissions, ACLs or extended attributes. A save can discard custom access rules and file metadata despite the broader approved metadata-preservation policy. | Source-confirmed replacement path; no OS ACL/xattr reproduction in this section. Shared filesystem implementation was not reopened. Log only; repair would need shared write-contract depth work. |

| R112 | MAJOR | 27 | The Linux Nix install phase copies only `usr/bin/oarlock` and `usr/share/*`, while the Tauri bundle declares an `oarlock-cli` external binary. Other binaries from the Debian payload are discarded, leaving the Nix package without the bundled CLI sidecar. | Source-confirmed packaging omission; no Debian payload or Nix runtime reproduction. Log only. |
| R113 | MAJOR | 27 | Release workflow_dispatch accepts a branch but uses `github.ref_name` as its release tag/name. Such a run can create a branch-named draft release; the AppImage repair and updater-manifest jobs run only for tag refs, so those draft artifacts also bypass the release repairs. | Source-confirmed trigger/conditions mismatch; no workflow dispatched or remote release changed. Log only. |
| R114 | MAJOR | 27 | `release.yml::patch-updater-manifest` treats every failed latest.json download as proof that updates are disabled, and ignores signature-download failures. An authentication/network/download failure can therefore leave stale AppImage URLs/signatures while the patch job succeeds. | Source-confirmed failure handling; dormant while updater artifacts are disabled. No remote failure injection. Log only. |

| R115 | BLOCKER | 28 | `scripts/app-lab/fs-churn.mjs prepare ROOT` recursively deleted ROOT before attempting to archive the source repository. An existing destination lost all contents even when the source was invalid and preparation failed. | FIXED within section: replaced deletion/recursive destination creation with parent creation and exclusive destination mkdir. Regression reproduced disappearance of a temporary sentinel before the fix and verifies preservation afterward. Two production lines plus a 27-line test; no new interface/model/abstraction. Existing destinations must now be removed deliberately before reuse. |
| R116 | MAJOR | 28 | `scripts/app-lab/export-tree.sh` describes a pristine revision plus benchmark hooks but applies every current dirty diff in several broad application/build files and links the working tree's node_modules. Unrelated changes or newer dependencies can contaminate the supposed baseline and invalidate comparisons. | Source-confirmed export inputs; no baseline export run and no prior sections reopened. Log only; no baseline-isolation redesign. |
| R117 | MAJOR | 28 | `scripts/lib/process.ts::capture` kills only the direct child on timeout but resolves on close after inherited stdout/stderr pipes close. Surviving descendants holding those pipes can keep a timed-out harness operation pending; output is also buffered without a byte cap. | Source-level subprocess ownership/resource risk; no orphan-process or large-output reproduction. Log only; no process-supervision changes. |
| R118 | MAJOR | 28 | `scripts/ipc-profile/smoke.ts` still adds/removes watches using path arrays, discarding the registration result, and invokes interactive searches without request ownership. This harness has not been adapted to the native handle/request ownership contracts introduced earlier, so it cannot establish coverage of those lifetimes and may fail against the current API. | Source-confirmed old invocation shapes; native interfaces in DONE sections were not reopened and the GUI harness was not executed. API compatibility/runtime failure remains a depth check. Log only. |
| R119 | MINOR | 28 | `scripts/dist-graph.mjs::WINDOW_HTML` lists main/settings only, omitting the quick-terminal HTML entry. Its startup graph check therefore does not cover the third shipped window. | Source-confirmed coverage omission against section 27's input inventory; no current quick-window size regression asserted. Log only. |
| R120 | MAJOR | 28 | `src-tauri/tests/common/mod.rs::run_git_in` runs repository-mutating fixture commands with inherited Git context variables. GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE can redirect fixture setup outside its temporary directory, undermining test isolation and potentially changing another repository. | Source-confirmed inherited-environment path; no destructive fixture reproduction attempted. Production Git code in DONE section 15 was not reopened. Log only. |

| R121 | MAJOR | 29 | SECURITY.md and the security-model guide promise that API keys live only in the OS keychain and never on disk, while README explicitly documents the Linux credential file. Users evaluating Linux secret storage receive contradictory security guarantees. | Confirmed within this section's documentation; credential implementation was not reopened. Log only. |
| R122 | MAJOR | 29 | The PTY shell-integration guide still describes installing fish hooks into `~/.config/fish/conf.d/oarlock.fish`, contradicting the approved launch-only, profile-isolated integration. Following it while maintaining or troubleshooting hooks could reintroduce global-shell contamination. | Source-confirmed stale guide against the established review decision; shell code was not reopened. Log only. |
| R123 | MAJOR | 29 | The WebGL renderer guide says terminals share one WASM instance, while the resource-efficiency guide documents one instance per terminal. The inconsistent ownership description misstates how closing a terminal releases its linear memory. | Direct documentation contradiction; no terminal code reopened. Log only. |
| R124 | MINOR | 29 | README's Checks block runs `cd src-tauri && cargo clippy` followed by another `cd src-tauri && cargo nextest`. Pasting the block in one shell makes the second cd target a nonexistent nested directory, so the test command is not executed. | Source-confirmed shell working-directory sequence; no Rust command rerun for this documentation-only finding. Log only. |
| R125 | MINOR | 29 | The historical editor-regex README first says both current MatchScan/cursor paths exceed the deadline, then says the old MatchScan reproduction now returns without evaluating regex. The conflicting expected results make the reproduction instructions ambiguous. | Internal documentation contradiction; historical hostile-regex probes were not run. Log only. |

| R126 | MINOR | 30 | Brand-kit Android round launcher PNGs visibly crop the upper oar blade and lower shaft at the circular edge. The web icons also declare maskable use while some light artwork lies beyond a centered 40%-radius circle (287 pixels at 192px; 2,153 at 512px), exposing it to analogous masking loss. | Confirmed by decoded-image/contact-sheet inspection and a pixel geometry check; actual device launcher rendering was not exercised. Mobile/web handoff assets, not a demonstrated desktop regression. Log only. |
| R127 | MINOR | 30 | The brand-guide PDF is eight full-page raster images with no text layer or tags. Text extraction produces only eight page separators, so its visible instructions cannot be searched, selected or read as document text by assistive tools. | Confirmed by build-guide.py, pdfinfo and pdftotext; rendered pages are visually readable. Log only; no PDF regeneration or accessibility redesign. |
| R128 | MINOR | 30 | The documented branding rebuild updates PNG/SVG/PDF/platform assets but none of its three generators regenerates asset-manifest.json. A legitimate rebuild that changes assets leaves the published byte/hash inventory stale, although the current checkout matches it exactly. | Source-confirmed missing manifest refresh step; no external-font rebuild performed. Log only. |
| R129 | MINOR | 30 | All 18 existing src-tauri/icons/ios PNGs retain alpha values 254–255, while the supplied brand-kit iOS exports are opaque and its finalizer only handles branding/app/platforms/ios. The shipped-source icon set therefore does not receive that opacity cleanup. | Confirmed by decoding every iOS asset; no iOS distribution attempted or desktop impact claimed. Log only. |

| R130 | BLOCKER | F1 | `agent.rs:158–168,197` identifies an entire hook group as Oarlock-owned when any command contains an owned marker, then removes that whole group. Re-enabling integration therefore deletes unrelated user commands placed in the same group as an Oarlock hook. | REPRODUCED in a temporary Rust harness compiled from the production functions: re-enabling removes a foreign command sharing an owned group. A second probe shows a wholly foreign command mentioning the marker is also removed. No actual user settings were changed; no production edit. |
| R131 | BLOCKER | F1 | `agent.rs:249–255` writes to a predictable `*.oarlock-tmp` path using `std::fs::write`, which follows an existing symlink and truncates its target before the rename. A pre-existing staging symlink can therefore overwrite a different user file; simultaneous installers also share that staging path. | REPRODUCED in an isolated temporary directory with the production write_atomic function: a pre-existing staging symlink caused the victim file to be overwritten while the function returned success. Concurrency was not reproduced. No actual user files or production code changed. |

| R132 | MAJOR | F1 | `ai_sessions.rs::write_versioned` skips the expected-revision check whenever `migrate` is true. After deletion increments the native revision and removes message files, a delayed migration can recreate that conversation file from stale bytes while legacy backup/source data is still available. | Source-confirmed bypass/interleaving; metadata tombstones may keep the chat hidden, but do not prevent the message-file recreation. No delayed-migration reproduction run. Log only. |
| R133 | MAJOR | F1 | `ai_sessions.rs::read_stored` uses unbounded `fs::read` before checking the 128 MiB conversation limit. An oversized on-disk conversation is fully allocated before rejection, contrary to the stated memory bound, risking memory exhaustion on load. | Source-confirmed order; no large allocation/crash reproduction. Log only. |
| R134 | MAJOR | F1 | MCP credential staging reads through `NativeVault::get` -> `secrets::backend_get`, which uses non-strict reads. Damaged/incomplete values become None; `credentials::commit` skips their replacement, can publish the new credential namespace, and then retires the old accounts. A successful settings save can therefore discard damaged credential material without a recovery error. | Source-confirmed cross-file path inside F1; no actual keychain corruption performed. Existing fake-vault tests do not exercise damaged native reads. Log only. |
| R135 | MINOR | F1 | `mcp/logs.rs::LogStore::read` detects dropped lines using a global sequence gap. Activity from server B between two lines from server A therefore marks A's next page as having a gap even when none of A's lines were evicted. | Source-confirmed false-positive loss indicator; no new test. Log only. |
| R136 | BLOCKER | F1 | `mcp/stdio.rs::write` holds the stdin mutex across blocking `write_all`. `stop`, `terminate` and `kill_now` call `close_stdin`, acquiring that same mutex before signalling the child. A server that stops reading a full pipe can therefore prevent its own termination indefinitely; synchronous `mcp_kill` calls this path. | Source-confirmed lock/wait cycle; no stalled-child or live UI reproduction in the breadth pass. No writer/lifecycle redesign attempted; log only. |
| R137 | MAJOR | F1 | `mcp/oauth/callback.rs::Listener::wait` spawns an untracked task for every accepted connection with no concurrency cap. Slow local clients can accumulate sockets/tasks during sign-in; cancellation drops the listener but not its spawned handlers, and response writes have no timeout. | Source-confirmed admission/lifetime gap; headers have a ten-second read timeout, which limits individual reads but not concurrent admission. No socket-flood reproduction. Log only. |
| R138 | MAJOR | F1 | `mcp/stdio.rs::spawn` attaches the Windows Job Object only after starting the process and continues with no job when assignment fails. Early descendants can escape, and the failure path only kills the direct child later. | Source-confirmed Windows ownership gap; not executed on Windows. Related pattern to R046/R069, separate MCP call site inspected here; earlier DONE sections were not reopened. Log only. |

| R139 | MAJOR | F1 | `mcp/oauth/flow.rs::discover` selects the first policy-acceptable authorization-server URL, then only tries metadata paths for that issuer. It does not try later advertised issuers when the selected issuer has unavailable or unsupported metadata, so an otherwise usable server can fail sign-in. | Source-confirmed selection/fallback gap; no multi-issuer HTTP reproduction. Log only; no discovery-policy change. |
| R140 | MAJOR | F1 | `mcp/oauth/flow.rs::parse_token_response` classifies every structured OAuth error returned with HTTP 400/401 as `Rejected`; `mcp/oauth/mod.rs::refresh` responds by forgetting saved tokens. Errors other than an invalid refresh grant can therefore destroy retryable sign-in state. | Source-confirmed classification and deletion path; no live credential deletion or transient-provider reproduction. Log only. |
| R141 | MAJOR | F1 | `mcp/oauth/mod.rs::sign_in` observes cancellation while waiting for the browser callback, but does not race the preceding preparation or subsequent token exchange against cancellation. Cancel can return while discovery/registration/exchange continues until its HTTP deadlines; preparation also retains the refresh lock. | Source-level cancellation gap. The final saving guard prevents a cancelled attempt from committing tokens; this finding does not claim that guard is bypassed. No delayed-request cancellation reproduction. Log only. |
| R142 | MAJOR | F1 | `net/image.rs::ImageRequests::start` admits requests with an effectively unlimited active-request bound (`usize::MAX`). The 16 MiB per-image and total-time limits do not bound concurrent response memory; literal-IP destinations also need no queued DNS lookup. | Source-confirmed missing aggregate admission bound; no high-fanout memory stress. Separate from completed-cache retention. Log only; no new resource policy proposed or implemented. |
| R143 | MAJOR | F1 | `shell/background.rs` marks a completed job finished after a bounded reader-drain wait, while blocking reader threads still retain the process/log allocation. If an escaped descendant holds an output pipe open, finished-history eviction cannot reclaim that retained allocation or reader thread. | Source-level conditional retention risk; no detached-descendant reproduction in this pass. Distinct from the log-entry cap, which correctly prunes registry entries. Log only; no process-supervision redesign. |

| R144 | MAJOR | F1 | `skills/mod.rs::skills_set_enabled` clones settings under one lock, releases it for persistence, then reacquires it to replace the cache. Concurrent toggles can save the same old snapshot and lose one another's changes. | Source-confirmed transaction gap; no controlled concurrent save reproduction. Log only; no storage redesign. |
| R145 | MAJOR | F1 | `skills/mod.rs::with_settings` treats every read/parse failure as empty default settings. A damaged or temporarily unreadable file silently loses its disabled-skill list in memory, and the next save replaces that file with the fallback state. | Source-confirmed recovery gap; no real user settings modified. Log only. |
| R146 | MAJOR | F1 | Skill replacement discards the installed directory before removing staged Git metadata and renaming the replacement. `skills_install_commit` falls back from failed trash to permanent deletion; a subsequent placement failure can therefore remove the old skill without installing the new one, and staged content is then removed too. | Source-level destructive failure ordering in `skills/install.rs::place` and `skills/mod.rs::skills_install_commit`; no induced filesystem failure. Log only; transactional replacement would need depth review. |
| R147 | MAJOR | F1 | Skill file access checks the canonical path and size, then separately opens the pathname for an unbounded read (`skills/files.rs::resolve_inside/read_text`, `discover.rs::read_skill_text`). Replacing an ancestor/file between those operations can bypass the checked containment/secret-path or size assumptions. | Source-level check/open race; no adversarial filesystem reproduction. Log only; no handle or read-contract change. |
| R148 | BLOCKER | F1 | `agents/lib/format.ts::displayAgent` looked up arbitrary terminal-reported names on an ordinary object, accepting inherited properties. `__proto__` returned an object instead of text, which is not a valid React label; `constructor` returned a function. | FIXED locally with an own-property check. Added one regression covering three inherited-name spellings; it failed before the fix and passed after. Final diff: 8 insertions, 1 deletion across implementation/test, no interface/model/abstraction change. Full terminal-render reproduction was not needed to establish the incorrect return value. |
| R149 | MAJOR | F1 | `AgentLauncherPanel.tsx` adopts saved commands only during initial hydration, then saves its entire local command map. A panel left open while another window changes another agent's command can restore that stale command on its next edit. | Source-level stale whole-map save risk; no multiwindow UI reproduction. Log only; shared preference implementation was not reopened. |
| R150 | MAJOR | F1 | `agents/lib/review.ts::fireReview` marks a round reviewed and sets the phase before importing the runtime or submitting the review, with no rejection recovery. If import/submission fails, the same round is excluded from later retries and can remain stuck in reviewing. | Source-confirmed failure path; no model call or failed-import reproduction. Log only. |
| R151 | MAJOR | F1 | `firePendingReviewForSession` asks `managedAgentsStore.getBySessionId` for only the first matching agent, then returns if it has no pending review. With multiple agents in one chat, a pending review on a later agent can remain stranded when the chat is activated. | Source-level selection gap across two files within F1; no live multi-agent reproduction. Log only. |
| R152 | MAJOR | F1 | The dedicated skills watcher logs startup/registration failures without reporting degraded coverage to consumers (`skills/watch.rs`). Existing Settings/composer/trust views can remain stale while callers receive no watch-health error. | Source-confirmed silent failure path, separate from the ordinary watcher reviewed earlier. No OS watch failure injected. Log only; no watcher-contract proposal. |
| R153 | MINOR | F1 | `chat-code.tsx::HighlightedPre` retains the previous highlighted nodes when `code` or `lang` changes, until the asynchronous replacement finishes. During that interval, the visible code can disagree with the current Copy payload. | Source-confirmed transient stale display; no delayed-import mounted reproduction. Log only. |
| R154 | MAJOR | F1 | `chat-code-lezer.ts::highlight` parses and tokenizes the complete code block synchronously after loading its parser, with no input bound, work deadline or yielding. Large model output can therefore monopolize the UI thread despite the function returning a Promise. | Source-level responsiveness risk; no blocking-input benchmark or claim of a specific runtime threshold. Log only; no worker/resource-policy change. |
| R155 | MAJOR | F1 | `AgentRunBridge.tsx` caches the mutation fingerprint and marks approval IDs opened before its awaited file read. A message rerender can cancel that effect; the replacement effect sees the same fingerprint and returns, leaving the approval without its diff tab. | Source-level cancellation/retry gap; no mounted deferred-read reproduction. Log only. |
| R156 | MAJOR | F1 | Approval-diff preparation in `AgentRunBridge.tsx` resolves relative paths using the current `live.getCwd()` and passes only a path to the read/open callbacks. A retained approval from another workspace can therefore preview against current live context rather than its originating context. | Source-level context mismatch risk; actual native read environment and cross-space reproduction deferred. No claim that this preview code alone executes the approved write. Log only. |

| R157 | MINOR | F1 | PlanDiffReview.tsx counts additions/removals using sets, losing line order and multiplicity. Reordering or duplicating existing lines can display zero changes. | Source-confirmed display limitation; log only. |
| R158 | MAJOR | F1 | LocalAgentNotificationsBridge.tsx compares only the selected chat status, while chatStore.switchSession resets agentMeta to idle. Switching away from a busy chat can emit a false finished notification; activation opens the current panel without identifying the originating chat. | Source-confirmed cross-chat transition; no mounted notification reproduction. Log only. |
| R159 | MAJOR | F1 | agent.ts modelCache has no eviction or invalidation. Its keys include API-key values, and old provider instances remain reachable after key rotation/removal or repeated endpoint/model changes. | Source-confirmed retention; no heap measurement or claim that a removed key is subsequently used. Log only. |
| R160 | MAJOR | F1 | compact.ts counts reasoning parts as a fixed 64 characters regardless of text length. Large retained reasoning therefore bypasses the context estimate used for compaction. | Source-level undercount; no paid-provider context-overflow reproduction. Log only. |
| R161 | MAJOR | F1 | composerDrop.ts accepts a source environment but drops it from composer delivery; composer.tsx imports using its current environment. A cross-environment or navigation-overlapping drop can resolve the same path in the wrong environment. | Source-confirmed missing context; no cross-space drag reproduction. Log only; no drop-interface change. |
| R162 | MAJOR | F1 | imageAttachment.ts fully decodes images with createImageBitmap before checking dimensions and resizing. The encoded byte limit does not bound decoded pixel allocation. | Source-level resource risk, analogous to R103 but on AI attachment conversion. No oversized-allocation experiment. Log only. |
| R163 | MAJOR | F1 | modelPrefs.ts constructs complete favorite/recent arrays and reasoning-effort maps from a UI snapshot before asynchronous saving. Independent overlapping edits can submit stale replacements of these composite preference fields. | Source-level lost-update risk; native preference implementation was not reopened and a multiwindow reproduction is deferred. Log only. |
| R164 | MAJOR | F1 | agentsStore.ts and snippetsStore.ts set their initialized flag before awaited loading and never reset it on failure. A failed first load permanently prevents hydration retry for that page; optimistic save failures also have no local recovery handler. | Source-confirmed failure paths. Log only. |
| R165 | MAJOR | F1 | agents.ts/snippets.ts persist complete lists supplied by per-window stores. Concurrent independent imports/edits/deletions can overwrite each other; neither path supplies an expected revision or item patch. | Source-level lost-update risk; no real settings modified. Log only; no storage redesign. |
| R166 | MINOR | F1 | useSelectionAskAi.ts schedules selection-popup work with setTimeout without cancelling that callback during cleanup or dismissal. Pending work can reintroduce stale selection UI. | Source-level deferred-work risk; no mounted timing reproduction. Log only. |
| R167 | MAJOR | F1 | useMiniWindowGeometry.ts restores body.userSelect only on pointerup/pointercancel. Unmount during an armed drag has no gesture cleanup and can leave document-wide text selection disabled. | Source-confirmed missing cleanup; no browser gesture reproduction. Log only. |
| R168 | BLOCKER | F1 | planStore.applyAll checked queue membership only before asynchronous path validation. Rejecting the edit during that wait still dispatched its write. | FIXED: recheck queue membership after path validation, before dispatch. A controlled deferred-validation regression failed before the two-line fix and passed after. Test added in planStore.failures.test.ts; no interface, data-model or abstraction change. Already-dispatched writes are outside this fix. |
| R169 | BLOCKER | F1 | planStore.ts retains originalContent/isNewFile for review but applies proposedContent through an unconditional write; edit.ts also separates its read from an unconditional write. native.ts writeFile supplies no expected version. Changes made after review/read cannot be rejected by this caller contract. | Source-confirmed stale-content publication gap; no destructive live-file reproduction. AP003 deferred for breadth continuation at checkpoint 23; implementation still requires approval. Existing native save implementation in completed sections was not reopened. |
| R170 | MAJOR | F1 | readCache.ts uses a 32-bit DJB-style hash plus byte size to suppress repeated file contents. Distinct same-size contents can be reported unchanged and withheld from the model. | Production-function probe: Aa and B@ both hash to 5862151 and both occupy two bytes. No hash/identity redesign in breadth; log only. |
| R171 | MAJOR | F1 | textWindow.ts returns endLine for the requested slice even when its character cap cuts content much earlier, and provides only line-offset continuation. Following endLine can skip unseen lines; the remainder of a single long line cannot be retrieved. Its named byte cap also counts UTF-16 characters rather than bytes. | Source-confirmed pagination/resource-unit mismatch. Log only; no result-contract change. |
| R172 | MAJOR | F1 | subagentTasks.ts rejects any event older than the latest global revision, although events contain only one task delta. If revision N+1 for task B arrives before N for task A, A is never updated; startup sorts events but steady-state handling does not reconcile gaps. | Source-level out-of-order delta risk; native event ordering not re-reviewed, so actual delivery interleaving remains to reproduce. Log only. |
| R173 | MAJOR | F1 | voiceRecording.ts has no recording duration or byte ceiling and calls recorder.start without a timeslice. A forgotten recording can accumulate audio until Stop, followed by full-buffer conversion/transcription. | Source-level resource risk; no prolonged recording experiment. New retention/admission policy deferred; log only. |
| R174 | MAJOR | F1 | proxyFetch.ts bounds aggregate upload bytes but retains every chunk in an array before admission. Tiny or empty stream chunks have no count/deadline bound, so the byte limit does not bound preparation memory or work. | Source-level input resource risk; no exhaustion experiment. Log only. |
| R175 | MAJOR | F1 | fs.ts plan-mode write_file treats every original-read failure as a new file and treats binary/oversized results as empty text. Review can therefore present an overwrite without its original contents or label an unreadable existing file as new. | Source-confirmed error classification; no live overwrite reproduction. Log only. |

| R176 | BLOCKER | F1 | MCP argument and elicitation form accumulators used ordinary objects. A valid field named __proto__ silently lost its entered/default value and its required-field error. | FIXED locally using null-prototype dictionaries; two new regression tests failed before the change and passed afterward. Five production lines changed, 28 test lines added, all in F1; no interface/model change. |
| R177 | MAJOR | F1 | config.ts::parseNamedValues deduplicates environment names case-insensitively, just like HTTP headers. Distinct Unix variables TOKEN and token collapse to one entry. | Production-function probe confirmed only TOKEN survives. Log only; no environment policy change. |
| R178 | MAJOR | F1 | SamplingDialog removes its request abort listener on unmount without aborting running.current. registerRequestHost cleanup answers pending requests as denied but does not abort their signal, so an active model generation can continue after its request host disappears. | Source-confirmed ownership gap across the two F1 components; no paid-provider or mounted unmount reproduction. Log only. |
| R179 | MAJOR | F1 | TauriStdioTransport.send serializes writes through a Promise chain without a pending-message/byte cap or local write deadline. A stalled native send retains every subsequently serialized message in that chain. | Source-level resource/admission risk; native implementation was not reopened and no large-allocation test attempted. Log only. |
| R180 | MAJOR | F1 | useUserSkills depends only on active/root and samples currentWorkspaceEnv once. Switching environments at the same root retains the previous slash-command catalog; changes to skills/trust also have no subscription here. | Source-confirmed stale catalog dependencies; invocation does re-list, so this is not claimed as a trust bypass. Log only. |
| R181 | MAJOR | F1 | SkillsSection.refresh and SkillsWatcher.check have no ordering between overlapping reads in the same scope. Older replies can restore stale skill/trust UI; ProjectTrustPrompt also hands an asynchronous decision directly to the parent setter without validating current navigation. | Source-level stale-state risks; native trust enforcement not re-reviewed and no authorization bypass claimed. Log only. |
| R182 | MAJOR | F1 | InstallSkillsDialog.fetchRepository accepts a late Git preview without checking whether the dialog closed or changed source. Close can run before a token exists; the late reply can repopulate the hidden dialog and leave its installation candidate uncancelled. | Source-confirmed contrast with the guarded ZIP branch; no actual clone/install performed. Log only. |
| R183 | MAJOR | F1 | McpSection.useMcpState starts snapshot reads before event listeners are established, and the initial status reply replaces the whole status list without ordering against events. An intervening change can be missed or a newer running/crashed status overwritten. | Source-level subscription/snapshot race; no delayed native-event reproduction. Log only. |
| R184 | MAJOR | F1 | McpSection.openEditor converts every mcp_secret_status failure into false for each credential. A keychain read error is presented as missing credentials; draftFromServer can then clear the OAuth client-secret flag or demand replacement of an existing secret. | Source-confirmed failed-read fallback and draft conversion; no real keychain deletion performed or claimed. Log only. |
| R185 | MAJOR | F1 | importConfig.alreadyPresent compares only command/arguments or URL, ignoring cwd, environment, credentials and HTTP-vs-SSE differences. ImportDialog treats those matches as already configured, preventing distinct server configurations from being selected. | Source-confirmed matching and UI filter; no external app configuration changed. Log only. |
| R186 | MAJOR | F1 | results.ts caps retained text/images but appends an uncapped note for each omitted/unsupported content item; these notes remain in stored output and model output. The stated result-text limit does not cover them. | Production-function probe retained 10,000 notes from 10,000 audio items. No memory exhaustion or provider call attempted. Log only. |
| R187 | MAJOR | F1 | config.ts::parseOverrides and projectServers.ts build tool-policy maps with ordinary-object assignment. A tool policy named __proto__ is not retained as an own allow/deny entry, so the frontend loses that configured policy. | Source-confirmed dictionary behavior; native enforcement and actual tool execution were not tested, so no demonstrated permission bypass is claimed. Log only. |
| R188 | MINOR | F1 | elicitation.ts dateTimeValue accepts syntactically shaped offsets without validating offset hours/minutes, and local date-time conversion drops fractional seconds. | Source-confirmed value-validation/conversion limitation; log only. |
| R189 | BLOCKER (split) | F2 | asset_all_folders.rs::respond authorizes a canonical pathname, then read opens that pathname later. Replacing the checked file or one of its directories with a symlink between those steps can make the open read an unauthorized target. | REPRODUCED in an isolated project copy. Superseded by R230 (accepted external race) and R231 (guaranteed untrusted-entry boundary). AP007 serves the authorized handle on tested macOS; Windows/Linux and protocol/scope scenarios remain unverified. |
| R190 | MAJOR | F2 | asset_all_folders.rs allocates and reads the entire file for requests without a usable Range header; only ranged replies have MAX_PART. There is also no admission budget before spawn_blocking, so large or concurrent preview requests can exhaust memory/workers. | Source-level resource risk; no large-allocation or thread-exhaustion experiment. Log only. |
| R191 | MAJOR | F2 | previewAfterRead silently retains ready content on every refresh failure, with no stale/error indication or retry. Deleted, denied or persistently unreadable Markdown therefore remains displayed as current. | Source-confirmed behavior, explicitly covered by an existing test; no change to the prior transient-read policy during breadth review. |
| R192 | MAJOR | F2 | MermaidDiagram only checks cancellation before starting mermaid.render; an in-progress render is not interrupted and blocks the shared serialized queue. Once near the viewport, a diagram stays eligible even after being hidden; the 32-entry cache also has no byte budget. | Source-level lifetime/resource gaps; library input limits may constrain individual diagrams, but no total render deadline/hidden-state ownership is supplied here. No hostile diagram/browser-freeze reproduction. Log only. |
| R193 | MINOR | F2 | PreviewLink prevents ordinary relative-link navigation only in onClick. MarkdownLink.onAuxClick does not invoke that guard for relative links, so middle-click leaves native navigation behavior unhandled. | Source-confirmed missing auxiliary-click guard; actual platform webview navigation not tested. Log only. |
| R194 | BLOCKER | F2 | localImages.joinPath allows .. to pop the share and server components of a UNC path. Resolving ../../other/pic.png from //server/share/docs produced //server/other/pic.png. | FIXED locally by retaining the UNC root depth. Two forward/backslash regressions failed before and pass after; 8 implementation lines added/1 removed plus 21 test lines added this turn (the test file already had 9 unrelated added lines). No native/public interface change. |
| R195 | MINOR | F2 | math.ts resets its loader promise after an import failure, but useMathPlugins retries only when the wanted boolean changes or a new consumer mounts. An unchanged open math document has no Retry path and can stay unrendered after a transient load failure. | Source-confirmed recovery gap; no module-loading failure injected. Log only. |


| R196 | BLOCKER | F3 | Vim `:1sort` and `:1,1sort` sorted the entire document, and `:1global` ran its nested command on all matching lines. The zero-based first line was treated as a missing endpoint by logical-OR defaults in `packages/codemirror-vim-core/vim.js:6280–6281,6411`. | FIXED: three defaults now use nullish checks. Production adapter/core reproduction sorted c/b/a into a/b/c for :1sort and dispatched three nested commands for :1global. New `packages/codemirror-vim/range.test.js` has five cases, including later-line and whole-file controls. Both sort regressions and the global regression failed before their fixes; all pass afterward. Three production lines replaced plus 34 test lines, under approximately 50 changed/added lines. No interface or model change. |
| R197 | MINOR | F3 | `languageResolver.ts:15,81–88` permanently negative-caches every unknown extension or extensionless basename. Opening distinct unknown names grows a page-lifetime Map even though those entries contain no parser. | Source-confirmed unbounded negative-cache keys; no long-session memory measurement. Log only. |
| R198 | MINOR | F3 | `languageResolver.ts:67` returns Plain Text for every .txt name before checking exact language filenames, so CMakeLists.txt has a Plain Text display name while the resolver selects CMake syntax. | Source-confirmed display/resolver ordering mismatch. No UI reproduction; log only. |
| R199 | MINOR | F3 | `scripts/vim-review/upstream-probe.js:123` reports top-level passed:true whenever the loop finishes, even with a nonempty failures array. Consumers must inspect failures/success rather than treating that boolean as suite success. | Source-confirmed ambiguous report semantics; no claim that the current external comparison runner ignores failures. Log only. |
| R200 | MAJOR | F3 | The Vim core's :set implementation reads only setArgs[0], including the new filetype reset special case, so additional options in a single :set command are not processed. | Source-confirmed first-argument-only implementation; the standalone multi-option probe lacked the full DOM/editor harness and did not establish mounted behavior. Treat as a compatibility issue to reproduce in depth, not a new-fork regression claim. Log only. |
| R201 | MAJOR | F4 | `useThemeFileEditing.ts:33–53` launches an independent read/parse/upsert for every editor write without ordering or a generation check. A delayed earlier read can upsert an older theme after a newer save; cleanup removes listeners but does not invalidate started ingestion/edit callbacks. | Source-confirmed async interleaving and lifetime gap; no mounted race reproduction. Native per-ID serialization orders arrival, not the original editor saves. Log only. |
| R202 | MAJOR | F4 | Theme-file ingestion retains only event path/source and resolves workspaceEnvForPath(path) when handling the event. Project theme files with equal paths in different WSL environments are not bound to the environment that produced the write. | Source-confirmed missing environment capture in this consumer; actual cross-distribution delivery not exercised. App-config theme files explicitly resolve to Local and are not the affected case. Log only. |
| R203 | MAJOR | F4 | Opening a theme for editing checks only this window's tabs, then writeThemeFile unconditionally writes the catalog copy over the editing file. An existing file with unapplied edits, or one open in another window, can be replaced even though it is not a new file. | Source-confirmed local-tab check and unconditional fs_write_file call. No live cross-window overwrite reproduction; log only, without changing materialization ownership. |
| R204 | MAJOR | F4 | `ThemeProvider.tsx:187–197` updates visible state and the startup shadow before fire-and-forget preference persistence. Rejection has no local catch, error display or rollback; the UI/shadow can continue showing an unsaved choice. | Source-confirmed failure handling gap. Preference implementation is already DONE and was not reopened; native write-failure UI reproduction remains for depth. Log only. |
| R205 | MINOR | F4 | Invalid JSON/theme validation on editor-file ingestion only writes a console warning and returns, unlike IO/save failures which show a toast. A successful file save can therefore leave the active theme unchanged without a visible explanation. | Source-confirmed `useThemeFileEditing.ts:49–51`; log only. |
| R206 | MAJOR | F4 | Delayed theme imports always select their first imported theme after saving, even after a newer selection or cancellation. Background-image import similarly sets the image and kind after completion without checking a later Remove/selection or unmount. | Source-confirmed completion ordering in ThemesSection.tsx and Cancel remaining active in ThemePastePanel.tsx. No live image/import race; log only, no ownership redesign. |
| R207 | MAJOR | F4 | `themes.rs::apply` clones the current catalog and scans/removes from the full vector once per upsert. Large batches have quadratic work while holding the shared theme-store mutex; the 50 MiB serialized bound is checked only later in persist, after cloning and applying the batch. | Source-confirmed complexity and post-allocation bound; no large-memory or stall benchmark. Log only; no new admission policy. |
| R208 | MINOR | F4 | Custom theme Edit/Remove controls are spans with role=button but no tabIndex or keyboard handler, nested in the theme-selection button. Keyboard users can select a theme but cannot operate these actions independently. | Source-confirmed markup in ThemesSection.tsx:417,432; no screen-reader/platform execution. Log only. |
| R209 | MAJOR | F4 | `themes.rs::Store::mutate` verifies disk only when the catalog changes. An identical upsert or deletion of a missing ID can succeed and publish the cached snapshot through the frontend command reply even when storage was removed/damaged after loading. | Source-confirmed no-op path; the frontend accepts successful snapshots as ready. No injected native/UI recovery reproduction. Log only; no recovery-contract change. |

| R210 | MAJOR | F5 | `fs/formatter.rs:156–169,230–261` creates a private Cancellation that no caller can signal and accepts formatting without window/page ownership or a concurrency budget. Closing/replacing the editor discards its result but does not stop the formatter; concurrent requests can each retain a 50 MiB input and output until their 20-second timeout. | Source-confirmed lifetime/admission gap; no process-exhaustion experiment. Log only; no new ownership or admission design. |
| R211 | MAJOR | F5 | `fs/formatter.rs:241–261` checks authorized_write_target and spawn_cwd but discards the resolved results, then resolves the executable and starts it using the original cwd string. A directory alias changed between validation and launch can change the formatter's execution context. | Source-confirmed check/use separation; no live redirection reproduction or claim that user-selected formatters are otherwise isolated. Log only. |
| R212 | MAJOR | F5 | `App.tsx:779–803` checks the captured terminal's prompt, then can await shell detection and reads the current window environment before writing cd. Its request counter changes only for another cd request; navigation, terminal restart and a program starting during the wait do not invalidate this action. It also uses the current preferred shell rather than the captured terminal's actual shell. | Source-confirmed stale-context/prompt interleaving; no running-terminal reproduction. Log only. |
| R213 | MAJOR | F5 | Native launch files are host filesystem paths, but `App.tsx:809–847` opens them through the active space's normal file handler without a Local environment/space binding. An Open With/second-launch file delivered while a WSL space is active can be interpreted in that environment instead of the host. | Source-confirmed missing environment in this handoff; Windows/WSL runtime outcome remains untested. Log only. |
| R214 | MAJOR | F5 | `EditorPane.tsx:668–686` drops the Git gutter baseline if gitFileBase resolves before CodeMirror creates its view. The effect does not depend on editorView and handleCreateEditor does not replay the baseline, so the first-load gutter can stay empty until another triggering event. | Source-confirmed ordering gap consistent with the existing first-load test's documented deferred view creation; no mounted fast-reply reproduction. Log only. |
| R215 | MAJOR | F5 | EditorPane starts credential subscription/read work on every mount even with autocomplete disabled, and its unconditional resolveLanguage preload runs for binary/oversized documents that cannot use syntax highlighting. These eager paths bypass the later feature/readiness gates. | Source-confirmed unnecessary IPC/keychain and parser-load eligibility; actual incremental memory/latency was not benchmarked. No claim that every mount causes a distinct dynamic module download. Log only. |
| R216 | MAJOR | F5 | `store_scope.rs:97–137` excludes native-owned stores by requested filename only. It accepts arbitrary other plain filenames without checking whether they are filesystem aliases of a forbidden store or leave the data directory, so the wrapper itself does not establish its documented disk-identity boundary. | Source-level boundary gap requiring an alias already present on disk. Underlying plugin alias behavior and end-to-end exploitation were not exercised; retain for depth validation, not as a reproduced security blocker. Log only. |
| R217 | MAJOR | F5 | `fs/formatter.rs:59–65` always passes rustfmt --edition 2021, regardless of the project's edition. Valid newer-edition syntax can therefore fail format-on-save instead of following project settings. | Source-confirmed hard-coded edition; Rust 2024 corpus/project-config reproduction deferred. Log only. |
| R218 | MINOR | F5 | `EditorPane.tsx:439–469` catches an LSP formatting error and continues saving, whereas external formatter failure returns false without saving. The same Format on save preference has different failure behavior depending on the selected formatter. | Source-confirmed inconsistency; intended product policy unresolved, so not claimed as data loss. Log only. |
| R219 | MINOR | F5 | `WorkspaceInputBar.tsx:99–109` schedules mode-switch focus in requestAnimationFrame without invalidating it on navigation, another mode switch or unmount. A delayed callback can target a formerly active terminal/input. | Source-confirmed missing lifetime check; browser focus outcome not reproduced. Log only. |
| R220 | MINOR | F5 | `pty/agent_detect.rs:357–373` matches every non-option whitespace token, not only executable positions. Commands such as echo claude or cat /tmp/codex can be labelled as an active agent. | Source-confirmed heuristic false-positive path; existing 30 detector tests pass but do not cover these examples. No live notification reproduction or parser redesign. Log only. |
| R221 | MINOR | F5 | AGENTS.md's main editor architecture paragraph still lists a custom {file} formatter template even though the same paragraph and current native implementation require stdin/stdout JSON argv and reject {file}. The separate coverage document's Current pass: 106 predates this coverage-first phase without linking to this ledger. | Documentation consistency issue; historical records preserved, no cleanup rewrite. Log only. |

| R222 | MINOR | AP002 | An explicit completion request whose shell verification fails can show both the specific shell-verification error from `ownedPathCompletion` and the generic no-completion notice from `shellEditor`. | Source-confirmed paired notification paths; no mounted UI reproduction. Logged without a third edit to either file in this continuation. |

| R223 | BLOCKER | F1 / depth | Hook merging silently replaces valid JSON with an unexpected structure: for example a `Notification` object containing user data is replaced by a new array, rather than being preserved or causing an error. Non-object roots and non-object hooks are likewise reset by the same code. | REPRODUCED in a temporary Rust harness for the non-array event value; other shape cases are source-confirmed only. Whether a particular agent version accepts that value is not established. AP004; no production change. |

| R224 | BEST EFFORT (accepted) | AP008 / depth | An already-open copy destination can be moved outside the authorized workspace after its final location check but before publication. The copy still writes into the same opened directory at its new location and can report the old path. | REPRODUCED in a copied native project. The user superseded AP011's continuous-location guarantee for noncooperating same-user races. Copy remains refused until the later restoration and tests; no Explorer operation was re-enabled in this batch. |
| R225 | BLOCKER (policy resolved) | R054 / depth | The dormant isolated index publisher can commit to its retained repository directory after another process moves that repository outside the authorized workspace, even though it reports the changed location afterward. | REPRODUCED with an injected hook immediately after the final validation and before the native index rename. Under AP012 the user chose authorization following the opened repository; a permanent native regression checks that the original is updated, a replacement at the old location is untouched, and the stale location is reported. The publisher is not wired into Source Control; the separate live Git R054 race remains present. |

## Architecture proposals

### AP001 — Bind each control reply to its exact native request and target window

Status: **DEFERRED TO DEPTH PHASE BY USER** (2026-10-28). Section 03 / R005. No implementation. The user selected deferral and authorized section 04 only; do not reopen section 03 during breadth review.

Problem: the pending map is keyed by the caller’s reusable request ID and contains only a reply sender. Timeout removes that entry; later reuse creates an indistinguishable entry. A late reply from the previous operation can satisfy the replacement. The reply command does not receive/check its calling window either. Existing tests cover framing, IDs, authorization and bridge disposal, but not this interleaving.

Evidence: in `src-tauri/src/modules/control.rs`, `forward_to_frontend` inserts `request.id`, removes it on timeout, and sends the same ID to the page. `control_respond` removes by the supplied ID and sends the response without operation or window validation. Sequence: A(X) dispatched → A times out → B(X) dispatched → A’s delayed response consumes B’s sender. Source inspection establishes the matching behavior; no live-window exploit/reproduction was performed in this breadth pass.

Options:

1. **Defer to the approved depth phase** and retain R005 as an unresolved blocker; continue coverage after the user says so.
2. Approve focused design/implementation now: give each dispatched request a native-issued, non-reused internal identity, retain the external client ID only for the socket response, bind the pending entry to its target window, and reject expired/wrong-owner replies. Determine reload-generation handling during that approved design; do not silently broaden into frozen ownership code.
3. Reject reused external IDs instead. This changes client compatibility and needs a bounded retention/expiry policy; it does not alone solve wrong-window replies.

Recommendation: **option 1 for this coverage-first phase**. For the later fix, prefer option 2 over retaining every external ID. This changes the pending-request data model/native reply ownership, so it is outside the small local-fix allowance even if part of the code change is short.

Required future regression cases: timeout then same-ID retry with the old reply arriving first; reply from a different window; owner closes/reloads before reply; normal stock CLI requests remain compatible. No tests or implementation for this proposal were added.

### AP002 — Bind shell path completion to its terminal and insertion context

Status: **IMPLEMENTED LOCALLY; PLATFORM VALIDATION OUTSTANDING** (2026-10-28). User approved the recommended scope; targeted source/ownership and available real-shell tests pass. Fish, PowerShell, cmd, Windows/WSL and Git Bash runtime checks remain release validation requirements. Historical breadth deferral remains in the checkpoint history.

Problem: R084 is reproduced at the production completion-function/real POSIX-shell boundary: a filename `$(printf oarlock_completion_probe)` is emitted unescaped and executes substitution when submitted unquoted. Files use their label as insertion text; directories explicitly insert the raw name and separator. A mounted UI exploit was not reproduced. R086 is source-confirmed and conditional: `blockController.ts` reads cwd for a leaf, but `pathComplete.ts` derives style and `fs_read_dir` workspace from global `currentWorkspaceEnv()`. `ShellInput` retains the editor while its leaf callbacks retarget; requests carry no owner/generation. A delayed response or retained editor may therefore produce results for a different owner, but no live cross-space reproduction or proof of CodeMirror accepting every stale response is claimed. Native `fs_read_dir` still performs authorization for the workspace passed; this is a context mismatch, not a demonstrated authorization bypass. Host Windows alone classifies local Git Bash as Windows path syntax, regardless of its shell.

Options:

1. Restrict completion to a deliberately small, unambiguous safe subset and suppress unsafe names/contexts until supported; this reduces functionality and still requires correct terminal ownership and stale-result handling.
2. Bind each request and acceptance to a terminal/session generation, its actual workspace and established shell dialect, and a parsed insertion context; escape or quote literal names for supported contexts, declining ambiguous ones. Preserve original display labels and directory continuation. This is the recommended bounded fix.
3. Delegate completion to the shell itself. This may provide native semantics but requires a separate protocol, shell integration and lifecycle design; defer it rather than silently expand this fix.

Proposed scope: propagate immutable owner/environment and trustworthy shell dialect from the terminal session into the command bar; snapshot owner, session generation, cwd, document/selection and request context before listing, invalidate responses and acceptance on retarget, restart, close, cwd or relevant editor change, and pass the captured workspace to `fs_read_dir`. Implement a pure, tested token/context parser and insertion encoder with explicit replacement ranges; use existing drop quoting only where its whole-argument semantics actually match completion. If required owner or shell metadata is unavailable, do not infer shell dialect from the host; withhold path completion with clear unobtrusive feedback. Preserve native authorization and secret-path policy. This may require a narrowly scoped native contract for trustworthy shell identity; determine feasibility before implementation, and do not claim process ancestry always identifies a nested interactive shell.

Compatibility/safety contract: POSIX shells and fish each require their own literal escaping and quote-state handling; PowerShell and cmd each require their own syntax and must not share a Windows-host heuristic. WSL uses its owning distro/environment and actual shell dialect, not Windows local path rules. Local Git Bash needs POSIX syntax despite Windows host. Unknown, nested or changed shell, malformed/incomplete quoting or unsupported constructs must decline completion rather than insert executable text. Support a safe explicitly defined subset first, including directories and existing prefixes, and avoid silently reinterpreting already typed shell syntax.

Acceptance tests: production completion-to-real-shell round trips for spaces, dollar/substitution, backticks, semicolons, ampersands, quotes, backslashes, Unicode and leading dashes, asserting one literal argument and no side effects for each available POSIX/fish/PowerShell/cmd dialect; quoted/unquoted prefixes, cursor mid-token and unsupported contexts; directory separators and retrigger; Windows Git Bash and WSL distro routing; unknown dialect refusal. Controlled delayed `fs_read_dir` responses must be rejected after leaf switch, session restart/close, cwd, document or selection change, including same cwd across different workspaces; verify the captured owner goes to the native request and native authorization remains enforced. Real-shell tests for unavailable platforms must run on their platform CI, not be represented as locally passed.

### AP003 — Conditional publication for reviewed AI edits

Status: **DEFERRED TO DEPTH** at checkpoint 23. The latest instruction to continue was interpreted as selecting breadth continuation; that assumption was stated before work. Section F1 / R169 remains an unresolved blocker. No implementation or authorization to implement this proposal.

Problem: a proposed edit can wait for review while another editor changes the file. Apply has the original text for presentation but sends only the replacement to native writeFile. Immediate edit tools have the same read/write gap. The caller cannot express the reviewed disk version, unlike the conditional-save policy previously approved for editors. The small R168 cancellation fix does not address this.

Options:

1. Defer investigation/design to the depth phase, retain R169 as an unresolved release blocker, and resume breadth at the next unread F1 file.
2. Approve depth now: establish a native conditional-publication contract for AI edits and plan application, carrying the reviewed baseline/identity, rejecting conflicts while retaining the proposed content, and defining new-file behavior. Reuse existing conditional-save machinery only after an approved review of its compatibility and authorization requirements.
3. Temporarily refuse these write paths until conditional publication is available, with a clear explanation. This is a product behavior change and also requires approval.

Recommendation: **option 1 during coverage-first review**, followed by option 2 before release. A JavaScript reread alone cannot close the race. Any implementation changes a native interface and touches completed filesystem ownership code outside F1; it is not covered by the small local-fix allowance.

Future validation: file changed while approval waits; same-text replacement with different native identity; two concurrent edits; new destination appears before apply; failed write preserves proposal; rejected queue item never dispatches; host/WSL/platform safe failures. No new native API or test was added for AP003.

### AP004 — Preserve foreign and ambiguous agent hooks

Status: **IMPLEMENTED LOCALLY** (2026-10-28). Exact known hooks are removed individually; foreign hooks and metadata are preserved, and ambiguous/unsupported shapes are refused. R130/R223 merge behavior has regression tests; actual updates to existing files remain restricted by AP005.

Problem: ownership is inferred from substrings anywhere in any command, then the entire containing group is discarded. This deletes foreign commands and their group metadata; a foreign command mentioning a marker is itself misclassified. Unsupported JSON shapes are replaced with defaults.

Options: (1) remove only commands recognized as Oarlock's known current or legacy hook forms, preserving foreign commands, group order and metadata, and refuse ambiguous matches or unsupported shapes without writing; (2) continue treating every marker substring as owned, accepting deletion of lookalike user commands; (3) refuse all existing mixed groups until the user manually separates them. Recommendation: **option 1**, including explicit failure instead of overwriting unfamiliar JSON, and preserving user entries while keeping idempotent migration. Matching exact historical forms needs a validated inventory; unknown legacy variants must not be silently deleted.

Required tests: mixed groups and matcher/metadata preservation; multiple foreign hooks; false-positive marker text; known old/current owned forms and repeated enable; invalid JSON and valid but unexpected structures; failures leave original bytes unchanged.

### AP005 — Safely publish agent hook configuration

Status: **IMPLEMENTED WITH USER-ACCEPTED BEST-EFFORT LIMITATION** (2026-10-28). Existing settings and verified symlink targets now update through native conditional saves where the shared writer is supported. The user explicitly accepted the remaining external-write race between the final check and replacement. Windows/safe-write-unsupported environments fail safely; runtime validation is outstanding.

Problem: a predictable temporary path follows a pre-existing symlink, overwriting its target before publication; concurrent operations can also share that path. Hook settings are shared with external applications and can themselves be symlinks. Current ordinary hook writes replace the link, while Pi resolves it, so choosing consistent behavior is a compatibility decision.

Options: (1) support user settings symlinks by binding their resolved target and parent safely, preserve the link, and refuse on retarget, unsupported safe-write/metadata preservation or conflicting changes; (2) refuse symlinked settings with a clear error; (3) replace symlinks as ordinary hook settings currently do. Recommendation: **option 1**, with uniquely and privately staged files, metadata/ACL preservation and native coordination of Oarlock writers; fail safely where ownership or safe publication cannot be enforced. Use the approved shared safe-write guarantees where applicable, but do not assume external applications honor Oarlock's locks. Before claiming cross-process no-lost-update guarantees, validate an enforceable platform-specific publication boundary or explicitly refuse unsupported cases; a check immediately followed by rename alone leaves a race. Existing K001 remains log-only unless separately authorized.

Required tests: staging symlink sentinel untouched; simultaneous Oarlock installers and external edits; settings-target symlink preserved, retarget/replacement rejected; interrupted/failing publication preserves original bytes and metadata; malformed structures do not write; safe failures on platforms without the required guarantees.

### AP006 — Existing agent settings under noncooperating writers

Status: **DECIDED — BEST-EFFORT UPDATES APPROVED** (2026-10-28). User explicitly selected option 2 and accepted the residual external-overwrite race. AP005 uses the shared conditional writer; unsupported platforms still fail safely.

Problem: the current shared writer explicitly says its final check plus replacement is not an atomic filesystem compare-and-swap. A real macOS two-process probe held `flock(LOCK_EX)` on an existing file; an independent process that ignored the lock both rewrote it and atomically replaced its pathname. The lock still referred to the old inode. Darwin's local `rename(2)` describes swap and exclusive-create, not conditional replacement of a particular unchanged file; the Linux rename API similarly distinguishes `RENAME_NOREPLACE` and `RENAME_EXCHANGE`. This proves advisory locking alone is insufficient on this host; it is not a proof that every possible platform mechanism is impossible. Windows share modes differ and have not been prototyped or tested.

Options: (1) retain the strict guarantee and investigate agent-specific managed hook or extension files that avoid modifying shared settings, leaving unsupported agents fail-safe. This changes integration architecture and may change which launches receive hooks; feasibility, trust prompts and compatibility must be checked per agent before implementation. (2) permit best-effort conditional checks and replacement, explicitly accepting a residual external-overwrite race and defining symlink behavior; this relaxes the user's prior guarantee. (3) retain the current refusal of changes to existing files while searching for an enforceable publication primitive. Recommendation: **option 1 for investigation, preserving strict refusal until a concrete per-agent design is approved**. Separate-file integration does not itself satisfy the original goal of updating shared settings/symlinks; it is a proposed alternative for the user's decision.

Evidence: `/tmp/oarlock-ap005-lock-probe.log`; Apple `flock(2)` https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html ; Linux `rename(2)` https://man7.org/linux/man-pages/man2/renameat2.2.html ; Windows `CreateFile` sharing semantics https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea . The macOS local manual describes `RENAME_SWAP` and `RENAME_EXCL`. Codex and Gemini document plugin/extension hook files, but their activation and trust constraints are not yet proven for this app: https://developers.openai.com/plugins/build/plugins and https://geminicli.com/docs/extensions/reference/ .

Required next-step evidence: per-agent and per-platform supported hook discovery, launcher/trust/upgrade behavior, symlink compatibility, real external write/replace races and recovery. Do not silently treat advisory locks or a post-write check as an enforced compare-and-swap.

### AP007 — Authorize the file handle used by asset previews

Status: **IMPLEMENTED; VALIDATION INCOMPLETE** (2026-10-28). Opens without reading, authorizes the opened handle's path, then serves that handle. Scope patterns are matched directly because Tauri's `is_allowed` resolves the pathname again. Unix opens use nonblocking/no-controlling-terminal flags, and nonregular files are refused. Fourteen targeted macOS tests pass, including replacements before opening and changed settings between requests; Linux/Windows, live protocol/origin checks and the complete proposed matrix remain outstanding. The ordinary Tauri asset protocol was not reviewed.

Problem: the custom preview scheme authorizes a canonical path and separately opens it, allowing a swapped entry or ancestor to redirect the open. Options: (1) open a file without reading contents, inspect and authorize the actual opened handle/path against the current asset scope and all-folders policy, then sniff and serve from that same retained handle; fail safely when the platform cannot establish the handle's identity or path. (2) recheck pathnames around the open, which still leaves a race. (3) temporarily disable the affected custom-scheme previews until a handle-bound implementation is available. Recommendation: **option 1**. It changes the native preview authorization boundary; preserve origin checks, denied-name behavior, range and HEAD semantics, and prompt setting/scope changes. Use nonblocking/regular-file checks so opening a FIFO/device cannot hang. The standard Tauri asset protocol is separate and has not been certified by this reproduction.

Required tests: deterministic file and parent swaps before open; unauthorized and dot-name targets rejected; allowed symlinks, ranges, HEAD, file replacement after opening, denied origins and setting/scope changes; platform-specific safe failures and no read before authorization.

### AP008 — Bind filesystem mutations and copies to authorized entries

Status: **TEMPORARILY REFUSED; RELEASE BLOCKED** (2026-10-29). The previously enabled macOS regular-file and symbolic-link copy path is guarded again after R224 and the AP011 decision; folder copy, other platforms, rename, move, and single/batch delete remain unavailable. Theme-file cleanup also uses delete and reports refusal. The underlying macOS handle-clone code is dormant and its helper tests do not represent enabled behavior. Requested recursive, mutation, multiwindow and platform coverage remains outstanding; R027 remains a release blocker.

Problem: Explorer delete/rename/move/copy authorize pathnames but subsequently resolve those names again. The controlled probes show a swapped ancestor can delete an outside file or copy outside content; rename and move share the path-based contract but were not independently reproduced. The existing pinned save/create helpers do not cover these mutations or recursive copy.

Options: (1) use native, environment-scoped directory/entry handles for authorization and operations, preserve symlink-entry behavior and mutation events, and refuse where an operation cannot enforce the required ownership/identity; (2) pin directory containment but compare final-entry identities on a best-effort basis, explicitly accepting the remaining entry-swap race; (3) disable affected operations until an enforceable boundary exists. Recommendation: **option 1**, with a bounded platform feasibility phase. Pinned parents can prevent ancestor redirection, but pathname unlink/rename is not automatically a conditional identity operation; no exact-entry guarantee should be claimed without platform-specific evidence. The user's AP006 best-effort decision applies to agent settings and is not generalized to destructive Explorer operations. Preserve supported WSL behavior where an enforceable mechanism exists, otherwise show an actionable safe failure.

Required tests: parent and final-entry swaps for delete/rename/move/copy, recursive-copy source and destination changes, symlink entries, permission failures, same/cross-workspace cases, multiwindow events and platform-safe failures. Establish behavior for already-dispatched operations and partial recursive work without silently widening the task into unrelated Git or editor architecture.

### AP009 — Whether to investigate system-level macOS mutation supervision

Status: **DECIDED — KEEP STRICT SAFETY; NO SYSTEM EXTENSION** (2026-10-28). The user chose to avoid the system extension and keep looking for a less intrusive enforceable mechanism. AP008's strict entry-identity rule remains in force. Real-filesystem tests show that opening the selected file and holding its parent directory does not make a name-based rename or unlink conditional: replacing the final entry makes the kernel act on the replacement. A 100-attempt concurrent folder-clone probe did not observe outside content copied, but that finite result does not establish the recursive race guarantees; Apple's clonefile documentation discourages directory cloning.

Option 1: investigate a separately signed macOS Endpoint Security system extension, registered to supervise relevant filesystem authorization events and deny unsafe concurrent changes while Oarlock operates. Apple's documentation says setup requires an Apple-issued entitlement, system-extension approval, and Full Disk Access. It offers rename/unlink authorization events and a fail-closed deadline mode. This is only a research direction: event coverage, entry identity at the kernel commit, failure/crash behavior, supported macOS versions/filesystems, privilege cost and release eligibility remain unproven. No entitlement, service, extension or product change has been made.

Option 2: retain the current safe refusals on macOS while seeking a less intrusive enforceable mechanism; investigate Windows handle-based operations on an actual Windows test host when available. This preserves the existing guarantee but keeps those Explorer actions unavailable. A best-effort check would reopen the accepted AP008 decision and is not recommended or authorized by the agent-settings exception.

Recommendation: retain the strict refusal unless the user explicitly wants the higher-permission system-extension investigation; do not claim Endpoint Security solves the race before a prototype and adversarial tests. Sources: [Apple's clonefile manual](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/clonefile.2), [Apple's Endpoint Security setup](https://developer.apple.com/documentation/endpointsecurity/monitoring-system-events-with-endpoint-security), [authorization event types](https://developer.apple.com/documentation/endpointsecurity/es_event_type_t), [deadline behavior](https://developer.apple.com/documentation/endpointsecurity/es_set_deadline_miss_mode(_:_:)).

### AP010 — Folder content consistency during copy

Status: **DECIDED — REQUIRE A CONSISTENT SNAPSHOT** (2026-10-28). The user selected a single consistent snapshot of the folder's contents. AP008's selected source and destination identity requirements and its no-follow behavior remain unchanged. A bounded stress probe observed no inconsistent results, but does not establish the required guarantee, and Apple's documented clone atomicity describes publication rather than source-snapshot isolation. A macOS filesystem snapshot requires superuser privileges and a separate entitlement. No folder-copy implementation has been enabled and no additional privilege or system extension has been requested.

### AP011 — Authorization when a pinned destination moves

Status: **DECIDED — REQUIRE CONTINUED LOCATION AUTHORIZATION; TEMPORARY REFUSAL IMPLEMENTED** (2026-10-29). The user chose to require the destination to remain authorized throughout the copy. R224 showed a copy publishing to its originally opened destination directory after that directory moved outside the workspace between the final path check and the handle-relative write. The native command and batch entry point now refuse before filesystem work; the dormant path must not be re-enabled until publication can enforce this policy. The reproduction was a controlled native batch interleaving using a test-only hook; no live Tauri or adversarial multi-process test was performed.

Option 1: require the destination to remain in an authorized location throughout publication. A pathname check before the write is insufficient to enforce that policy; a stronger enforceable boundary or safe refusal would be needed, potentially including temporarily disabling the restored macOS copy path. Option 2: attach authorization to the exact opened directory for the operation's lifetime, even after a move, and design accurate result reporting and mutation handling for that case. The existing opened-handle behavior is compatible with the second policy but is not currently documented as such and can report an obsolete path. Recommendation: option 1, retaining location-based workspace authorization, subject to the user's decision. No policy change or implementation has been made.

## Checkpoint and effort log

| Checkpoint | Sections completed | Findings/fixes | Review elapsed | Source edits |
| --- | --- | --- | --- | --- |
| Initial inventory | 0 | K001 carried forward; no code reviewed or changed | Not started | 0 |
| Checkpoint 1 (2026-10-28) | 01 DONE; 02 partial/TODO | R001–R003 logged; no fixes | 01: 23 s (20:07:02–20:07:25 UTC); 02: stopped when it reached/exceeded that baseline | 0 |
| Checkpoint 2 (2026-10-28) | 01–02 DONE | No additional findings; R003 retained; no fixes | 02 continuation: 25 s (20:10:12–20:10:37 UTC), within authorized five-minute cap | 0 |
| Checkpoint 3 (2026-10-28) | 01–03 DONE; 04 not started | R004/R005 logged; AP001 awaits answer; no fixes | 03: 79 s (20:14:06–20:15:25 UTC), within five-minute cap | 0 |
| Checkpoint 4 (2026-10-28) | 01–04 DONE | AP001 deferred by user; R006 fixed; R007 logged | 04: 175 s (20:17:28–20:20:23 UTC), within five-minute cap, including validation | 2 files, 1 edit each |
| Checkpoint 5 (2026-10-28) | 01–06 DONE | R008–R013 logged; R012 fixed; AP001 remains deferred | 05: 160 s; 06: 150 s, each within five minutes | 2 section-06 files, 2 edits each; no section-05 edits |
| Checkpoint 6 (2026-10-28) | 01–08 DONE | R014–R021 logged; R015 fixed; AP001 remains deferred | 07: 128 s; 08: 213 s, each within five minutes | restoreGrants.ts: 1 edit; restoreGrants.test.ts: 2 edits; section 08: 0 |
| Checkpoint 7 (2026-10-28) | 01–10 DONE | R022–R030 logged; no fixes; AP001 remains deferred | 09: 59 s; 10: 185 s, each within five minutes | 0 source edits |
| Checkpoint 8 (2026-10-28) | 01–12 DONE | R031–R040 logged; no fixes; AP001 remains deferred | 11: 43 s; 12: 204 s, each within five minutes | 0 source edits |
| Checkpoint 9 (2026-10-28) | 01–14 DONE | R041–R053 logged; no fixes; AP001 remains deferred | 13: 126 s; 14: 93 s, each within five minutes | 0 source edits |
| Checkpoint 10 (2026-10-28) | 01–16 DONE | R054–R065 logged; no fixes; AP001 remains deferred | 15: 193 s; 16: 95 s, each within five minutes | 0 source edits |
| Checkpoint 11 (2026-10-28) | 01–18 DONE | R066–R078 logged; no fixes; AP001 remains deferred | 17: 126 s; 18: 92 s, each within five minutes | 0 source edits |
| Checkpoint 12 (2026-10-28) | 01–20 DONE | R079–R088 logged; R084 blocker/AP002 awaits decision; no fixes | 19: 77 s; 20: 84 s, each within five minutes | 0 source edits |
| Checkpoint 13 (2026-10-28) | 01–22 DONE | R089–R094 logged; AP002 deferred by user; no fixes | 21: 166 s; 22: 98 s, each within five minutes | 0 source edits |
| Checkpoint 14 (2026-10-28) | 01–24 DONE | R095–R100 logged; F1–F5 unfrozen to TODO by user; no fixes | 23: 94 s; 24: 104 s, each within five minutes | 0 source edits |
| Checkpoint 15 (2026-10-28) | 01–26 DONE | R101–R110 logged; no fixes; AP001/AP002 remain deferred | 25: 83 s; 26: 162 s, each within five minutes | 0 source edits |
| Checkpoint 16 (2026-10-28) | 01–28 DONE | R111–R120 logged; R115 fixed; AP001/AP002 remain deferred | 27: 63 s; 28: 173 s, each within five minutes | fs-churn.mjs: 1 edit; fs-churn.test.ts: 2 edits |
| Checkpoint 17 (2026-10-28) | 01–30 DONE | R121–R129 logged; no fixes; AP001/AP002 remain deferred | 29: 70 s; 30: 134 s, each within five minutes | 0 source/asset edits |
| Checkpoint 18 (2026-10-28) | 01–30 DONE; F1 partial/TODO; F2 unstarted | R130–R131 logged; no fixes | F1: 202 s (22:14:15–22:17:37 UTC), stopped below prior 213 s ceiling | 0 source edits |
| Checkpoint 19 (2026-10-28) | 01–30 DONE; F1 partial/TODO; F2 unstarted | R132–R138 logged; no fixes | F1 continuation: 209 s (22:25:38–22:29:07 UTC), below 213 s ceiling | 0 source edits |
| Checkpoint 20 (2026-10-28) | 01–30 DONE; F1 partial/TODO; F2 unstarted | R139–R143 logged; no fixes | F1 continuation: 196 s (22:40:32–22:43:48 UTC), below 213 s ceiling | 0 source edits |
| Checkpoint 21 (2026-10-28) | 01–30 DONE; F1 partial/TODO; F2 unstarted | R144–R156 logged; R148 fixed | F1 continuation: 194 s (22:53:50–22:57:04 UTC), below 213 s ceiling, including validation | format.ts: 2 edits; format.test.ts: 1 edit |
| Checkpoint 22 (2026-10-28) | 01–30 DONE; F1 partial/TODO; F2 unstarted | R157–R175 logged; R168 fixed; AP003 awaits answer | F1: 469 s (23:00:02–23:07:51 UTC), below new ten-minute cap; ledger administration afterward | planStore.ts: 1 edit; planStore.failures.test.ts: 2 edits |
| Checkpoint 23 (2026-10-28) | 01–30, F1–F2 DONE; F3–F5 TODO | R176–R195 logged; R176/R194 fixed; AP003 deferred for continuation | F1: 310 s (23:12:35–23:17:45 UTC); F2: 189 s (23:17:45–23:20:54 UTC), each below ten minutes; ledger administration afterward | argumentsForm.ts / elicitation.ts / localImages.ts: 1 edit each; their tests: 2 edits each |
| Checkpoint 24 (2026-10-28) | 01–30, F1–F4 DONE; F5 TODO | R196–R209 logged; R196 fixed; no new architecture proposal | F3: 221 s (23:42:22–23:46:03 UTC); F4: 122 s (23:46:03–23:48:05 UTC); final regression validation and ledger administration afterward | vim.js: 2 edits; new range.test.js: 2 edits; F4: 0 edits |
| Checkpoint 25 (2026-10-28) | 01–30, F1–F5 DONE | R210–R221 logged; no fixes or new architecture proposal; three auxiliary rename-source checks unverified | F5: 330 s (23:50:41–23:56:11 UTC), below ten-minute cap; ledger administration afterward | 0 source edits |
| Checkpoint 26 (2026-10-28 local date) | Three remaining auxiliary rename-source entries DONE; primary sections unchanged | No new findings or fixes; old-side coverage gap closed | 108 s (2026-10-28 23:58:27–2026-10-29 00:00:15 UTC), below ten-minute total cap; ledger administration afterward | 0 source edits |

Checkpoint 1 history: user authorized sections 01–02 only. Stopped early under the explicit rule to stop when a section takes longer than another. Section 02 was **not DONE** at that checkpoint, and no later section was opened. Initial combined output for section 02 was truncated; missing content is not counted as inspected. No debugging/reproduction loop or code rewrite occurred.

Validation: `bun x vitest run src/modules/updater/updater.test.ts` — 2 tests passed. No test added because no fix was made. Section 02 tests were not run before the timing stop; its Linux portal fixture cannot run on this macOS host. No full-suite validation claimed for this documentation-only checkpoint.

Checkpoint 2: the user authorized finishing section 02 with a five-minute cap, then stopping. The three outstanding files were fully inspected. All 22 section files have received their single breadth pass. No frozen file was opened in this continuation; no section beyond 02 was reviewed. No architecture proposal, source edit, fix or new test.

Focused validation: `bun x vitest run src/modules/mac-privacy` — **45 tests passed in 7 files**; `cargo test --locked --lib mac_privacy::tests` — **8 native tests passed**. The Linux-only color-scheme portal integration fixture was inspected but not run on macOS. No full-suite or live OS-permission validation claimed.

Stopped at the requested checkpoint. Remaining: 28 TODO sections and 5 FROZEN groups. No questions or architecture decisions needed for sections 01–02; await user authorization before section 03. The five-minute exception applies to section 02 only.

Checkpoint 3: user authorized sections 03–04 with five minutes each. Section 03 completed; AP001 triggers the mandatory architecture checkpoint, so section 04 remains unopened/TODO. No frozen file was opened or edited. All source edit counts remain zero. Focused validation: 3 frontend bridge tests, 15 CLI tests, 10 protocol tests and 14 native control tests passed (39 native total). No build-sidecar execution, live app request test, full suite or other-platform validation claimed. Await answer on deferring AP001 versus authorizing depth work; do not proceed to section 04 without the response.

Checkpoint 4: user deferred AP001 to the depth phase and authorized section 04 with a five-minute cap. All 17 listed files received their non-frozen breadth pass. Shared menu/shortcut files contain AI/preview action identifiers; those destinations were treated as opaque and their feature implementations were not followed, reviewed or changed. Frozen inventory paths were not opened or edited. Section 05 remains unstarted.

Fix R006: `src/modules/shortcuts/shortcuts.ts` adds one `Spaces` list entry; `src/modules/shortcuts/shortcuts.test.ts` adds an import and a regression checking that Settings’ group-driven list includes all three space commands (10 added test lines). This uses the existing group/type/rendering behavior: no abstraction, data model or native/public interface change. One edit to each file, 11 added lines total; no cleanup edits. No file edited more than twice.

Validation: new test failed before the production correction; all **64 shortcut tests** and **7 native menu tests** passed afterward. Required checks also passed: types, lint (79 existing warnings), **5,414 frontend tests / 583 files**, Clippy all targets with warnings denied, and **1,540 native tests** (3 ignored). Scoped diff whitespace check passed. Native macOS menu interaction was not manually exercised. Logs: `/tmp/oarlock-coverage04-{types,lint,tests,clippy,native}.log`.

Stopped at checkpoint 4. No new architecture proposal or question; await further user authorization. No commits/pushes.

Checkpoint 5: user authorized sections 05–06 with five minutes each. All listed non-frozen responsibilities received one breadth pass; no frozen inventory path was opened or edited. No architecture change was proposed or implemented. R008–R011/R013 remain log-only source findings with reproduction limits stated above. No confirmed destructive Explorer scenario is claimed. No section beyond 06 was reviewed.

Fix R012: `src/modules/command-palette/lib/mru.ts` validates the stored ranking map before returning it (11 additions, 1 removal). `mru.test.ts` adds six malformed/valid-storage regression cases (23 additions, 1 import-line replacement); all original tests remain. Total final diff: 34 additions / 2 removals, within the approximately 50-line allowance. The production file had two edits including formatter normalization. The test file had two edits: the first unintentionally replaced its existing tests; the second restored all original tests and retained the additions before final validation. No third edit to either file. The test path was unchanged in the original PR, so it is counted as one new local supplemental path, not a new PR file.

Validation: Explorer **111 tests / 15 files passed**. The new MRU cases failed before the fix (5 failed, valid-data case passed); afterward the full frontend suite passed **5,420 tests / 583 files**, including all 11 MRU tests. Types, lint (**79 existing warnings**), scoped formatting/whitespace, Clippy all targets with warnings denied, and **1,540 native tests** (**3 ignored**) passed. Native search integration tests are included in that run. No live cross-environment UI testing or Windows/Linux platform validation claimed. Logs: `/tmp/oarlock-coverage05-tests.log`, `/tmp/oarlock-coverage06-{before,focused,tests,types,lint,clippy,native}.log`.

Stopping at checkpoint 5: **6 DONE / 24 TODO / 5 FROZEN groups; 108 reviewed / 1096 TODO / 545 FROZEN files**. No architecture question requiring an answer; wait for authorization before section 07. AP001 remains deferred to depth. No commits or pushes.

Checkpoint 8: user authorized only sections 11–12, five minutes each. All 54 listed paths received their eligible breadth pass; no dedicated frozen path was opened or edited, no product code changed, and section 13 remains unstarted. All ten new findings are in the register (eight MAJOR, two MINOR), with source evidence and reproduction limits. No architecture proposal was made; AP001 remains deferred.

Focused validation: 68 native watcher tests passed after rerunning with macOS FSEvents access. The initial restricted run had 59 passes and 9 OS-service access failures; the unrestricted retry passed all 68. Section 12 passed 107 tests in 19 files. No tests added because there were no fixes. Logs: `/tmp/oarlock-coverage11-watch.log`, `/tmp/oarlock-coverage11-watch-retry.log`, `/tmp/oarlock-coverage12-tests.log`. No full lint/type/native/frontend suite rerun claimed for this ledger-only checkpoint.

Stopped with **12 DONE / 18 TODO / 5 FROZEN sections; 271 reviewed / 929 TODO / 549 FROZEN files**. No question requiring an architecture decision. Await authorization before section 13. No commits or pushes.

Checkpoint 9: user authorized only sections 13–14, five minutes each. All 84 listed paths received their eligible breadth pass, with sampling limits stated in each section. Frozen inventory paths were not opened or edited; XML, preview, language override, theme storage and AI implementations were not investigated. No product code was changed and no section beyond 14 was opened for review. All thirteen new findings are in the register, with source/reproduction limits; no newly confirmed release BLOCKER is claimed.

Validation: section 13 passed 147 tests in 11 files; section 14 passed 78 frontend tests in 11 files and 49 native tests. Read-only helper probes checked the Vim command slot, search keymap ordering and URI conversions. Logs: `/tmp/oarlock-coverage13-tests.log`, `/tmp/oarlock-coverage14-tests.log`, `/tmp/oarlock-coverage14-native.log`. No full-suite/lint/type/build run or live Vim/LSP platform certification claimed for this ledger-only checkpoint. No new tests because no fixes were made.

Stopped with **14 DONE / 16 TODO / 5 FROZEN sections; 355 reviewed / 845 TODO / 549 FROZEN files**. AP001 remains deferred; no new architecture proposal or question. Await authorization before section 15. No commits or pushes.

Checkpoint 10: user authorized only sections 15–16, five minutes each. All 64 eligible paths received one breadth pass, with large-file sampling limits recorded per section. One misclassified AI-only path (`git/ai_diff.rs`) moved from section 15 to F1 by filename without opening; inventory totals remain 1,749 (1,251 PR and 498 local-only). Mixed UI files contain opaque AI imports/state; those implementations were not followed. No dedicated frozen file was opened or edited; no product code was changed. Section 17 remains unstarted.

All twelve findings R054–R065 are logged: one existing release BLOCKER still present in current wiring and eleven MAJOR source-level findings. R054 is completion of a previously approved but unfinished design, not a new architecture proposal. No depth investigation or implementation resumed. AP001 remains deferred. No new tests because no fixes were made.

Validation: **163 non-AI native Git unit tests, 61 Git integration tests, and 117 frontend tests in 12 files passed**. Logs: `/tmp/oarlock-section15-tests.log`, `/tmp/oarlock-section15-integration.log`, `/tmp/oarlock-section16-tests.log`. No full lint/type/build suite, signed-app helper execution, live UI race reproduction, or Windows/Linux validation claimed for this ledger-only checkpoint.

Stopped with **16 DONE / 14 TODO / 5 FROZEN sections; 419 reviewed / 780 TODO / 550 FROZEN files**. No fixes, source edits, architecture questions, commits or pushes. Await user authorization before section 17.

Checkpoint 11: user authorized only sections 17–18, five minutes each. All 80 listed paths received a sampled breadth pass; limitations are stated per section. Dedicated frozen paths and implementations remained untouched. No source edits, fixes, added tests or new architecture proposals. All thirteen findings R066–R078 are logged (eleven MAJOR, two MINOR); source-level risks are not presented as live reproductions. Section 19 remains unstarted.

Validation: first native PTY run had **186 passed, 1 failed, 1 ignored**; the single timing-sensitive deadline test passed in isolation (R074). Shared native process tests **16 passed**, scrollback tests **7 passed**, frontend section-18 tests **148 passed in 17 files**. Fish was unavailable, so its fixture was inspected but not executed. Logs: `/tmp/oarlock-section17-{pty,retry,proc,scrollback}.log`, `/tmp/oarlock-section18-tests.log`. No full-suite, lint, types, Clippy, live UI or Windows/Linux certification claimed for this ledger-only checkpoint.

Stopped with **18 DONE / 12 TODO / 5 FROZEN sections; 499 reviewed / 700 TODO / 550 FROZEN files**. AP001 remains deferred, K001 remains log-only. No architecture question requiring a decision; wait for user authorization before section 19. No commits or pushes.

Checkpoint 12: user authorized only sections 19–20, five minutes each. Completed 76 eligible paths (47 + 29). One local-only AI snapshot path was identified during symbol inventory and moved from section 19 to F1 before implementation review. Inventory remains 1,749 unique paths (1,251 PR, 498 local-only). Dedicated frozen implementations were not reviewed or edited; mixed-file references remained opaque. No source files changed, no fixes or persistent regression tests added.

All ten findings R079–R088 are recorded: **one BLOCKER, seven MAJOR, one MINOR and one NIT**. R084's harmless production-function/real-shell probe confirmed executable completion text; AP002 triggers the mandatory architecture checkpoint. Other MAJOR items remain source-level risks with reproduction limits recorded. AP001 remains deferred; K001 remains log-only.

Validation: section 19 **247 frontend tests / 20 files**, **17 native tests**; section 20 **121 frontend tests / 13 files**, all passed. Native checks ran on macOS; Linux GTK/Wayland and Windows runtime behavior were not exercised. No full lint/type/Clippy/build suite or live GUI certification claimed for this ledger-only turn. Logs: `/tmp/oarlock-section19-tests.log`, `/tmp/oarlock-section19-native-{read,write,image,primary}.log`, `/tmp/oarlock-section20-tests.log`.

Stopped with **20 DONE / 10 TODO / 5 FROZEN sections; 575 reviewed / 623 TODO / 551 FROZEN files**. Await the user's AP002 decision and authorization before section 21. No commits or pushes.

Checkpoint 13: user deferred AP002 to depth and authorized only sections 21–22, five minutes each. Completed 35 eligible paths (23 + 12), each with one sampled breadth pass. All six findings R089–R094 are recorded: **four MAJOR and two MINOR; no new demonstrated BLOCKER**. No fixes, source edits or persistent tests added. No architecture implementation or new proposal; AP001/AP002 remain deferred, K001 remains log-only. Frozen areas were not opened or edited. Findings are source-level risks with reproduction limits recorded, not claims that all failure scenarios were reproduced.

Validation: **269 tests passed across 15 files** (211 WebGPU + 58 WebGL). No full application/platform/GPU-driver validation claimed; focused harnesses passed. Ledger-only changes do not warrant full frontend/native build suites. Inventory remains **1,749 unique paths: 1,251 PR and 498 local-only**.

Stopped with **22 DONE / 8 TODO / 5 FROZEN sections; 610 reviewed / 588 TODO / 551 FROZEN files**. Await authorization before section 23. No commits or pushes.

Checkpoint 14: user authorized sections 23–24 and unfroze all previously held areas. F1–F5 retain stable section IDs and now follow section 30 as TODO, under the same time/fix/architecture/checkpoint rules. No formerly held section was reviewed in this turn; historical frozen counts and gaps remain historical. AGENTS.md was consulted as repository instructions, not marked reviewed as a product/documentation section. K001 remains explicitly log-only; AP001/AP002 remain deferred to depth.

Completed 102 paths (30 + 72) with one sampled breadth pass. All six findings R095–R100 are recorded as **MAJOR source-level risks**, with reproduction limits. No new demonstrated BLOCKER, no architecture proposal, no source edits, fixes or new persistent regression tests. Existing dirty work was preserved; only this ledger changed.

Validation: **729 frontend tests across 28 files, plus two native font tests passed**. Both adapted WASM artifacts match recorded hashes; all 24 WOFF2 headers/lengths checked. No full build/lint/type suite, runtime platform certification, benchmark, binary regeneration or exhaustive large-file audit claimed. Inventory remains 1,749 unique paths (1,251 PR / 498 local-only).

Stopped with **24 DONE / 11 TODO / 0 FROZEN sections; 712 reviewed / 1037 TODO / 0 FROZEN files**. Await authorization before section 25. No commits or pushes.

Checkpoint 15: user authorized the next two sections only, retaining the previous unfreezing and limits. Completed sections 25–26, 119 paths (62 + 57), as sampled breadth passes. All ten findings R101–R110 are in the register: **nine MAJOR and one MINOR**, with source evidence and reproduction limits. No new confirmed BLOCKER or architecture proposal; AP001/AP002 remain deferred and K001 remains log-only. No source edits, fixes or new tests. Earlier DONE sections were not reopened; instruction consultation is not product coverage of F5.

Focused validation: section 25 **130 frontend tests / 15 files and 10 native vibrancy tests**; section 26 **116 frontend tests / 26 files and 16 native tests** (8 preferences, 8 history), all passed. Native checks ran on macOS; Linux portal behavior, Windows and actual GUI races were not exercised. No full lint/type/Clippy/build suite or release certification claimed for this ledger-only turn. Logs: `/tmp/oarlock-section25-tests.log`, `/tmp/oarlock-section25-native-tests.log`, `/tmp/oarlock-section26-tests.log`, `/tmp/oarlock-section26-native-tests.log`, `/tmp/oarlock-section26-history-tests.log`.

Stopped at **26 DONE / 9 TODO / 0 FROZEN sections; 831 reviewed / 918 TODO / 0 FROZEN files**. All 1,749 inventory paths remain unique. No source file edited more than twice and neither section exceeded the earlier 213-second maximum. Await authorization for sections 27–28; no outstanding architecture question from this checkpoint.

Checkpoint 16: user authorized sections 27–28 only with the same breadth/time/fix limits. Reviewed 117 original paths and added one regression-test path. Inventory is now **1,750 unique paths: 1,251 published PR paths and 499 local-only paths**. All ten findings R111–R120 are recorded: **two BLOCKERs (R115 fixed; R111 unresolved), seven MAJOR and one MINOR**. Nix release hashes cannot be invented; R111 remains logged for release preparation. No new architecture proposal; AP001/AP002 remain deferred, K001 remains log-only.

Validation: JSON/plist parsing, locked offline Cargo metadata, three shell syntax checks and one Python syntax check passed. Section 28's focused suite finished with **71 tests passing in 12 files**, including the new deletion regression. Initial restricted run had 69 passes and one localhost-listener failure; the permitted listener retry passed, then the full focused selection passed. The new regression failed before the fix (sentinel deleted) and passed afterward. `bun run check-types` passed; `bun run lint` passed with 79 warnings. The formatter ignored the scripts path by configuration and made no changes; the new test was formatted manually within its second edit. Diff whitespace checks passed. No full frontend suite, Clippy/native test run, release packaging or GUI benchmark certification claimed. Logs: `/tmp/oarlock-section28-{tests,listener-retry,tests-final,churn-before,churn-after,types,lint}.log`; Cargo metadata: `/tmp/oarlock-section27-cargo-metadata.json`.

Stopped with **28 DONE / 7 TODO / 0 FROZEN sections; 949 reviewed / 801 TODO / 0 FROZEN files**. Only the ledger, the two-line fixture setup fix and its test changed this turn. No file edited more than twice; both sections stayed below the previous maximum. Await authorization for sections 29–30; no new architecture question.

Checkpoint 17: user authorized sections 29–30 only with the same procedure. Completed 250 paths (37 documentation/policy paths and 213 branding/image paths). All nine findings R121–R129 are recorded: **three MAJOR and six MINOR**. No new BLOCKER, architecture proposal, fix or test. AP001/AP002 remain deferred; K001 remains log-only. Previously DONE code sections were not reopened. All former frozen areas remain TODO in their established ledger order.

Validation: current-document relative-link scan found zero missing targets; all 162 raster/icon files decoded; dimension-name checks found no mismatches; all 37 SVGs and two XMLs parsed, with no external href or executable-element/event-attribute flags; all JSON/web manifests parsed. All 157 branding manifest entries match sizes and SHA-256 hashes, with no missing or unlisted branding files. PDF metadata/read-only rendering passed for all eight pages; text extraction exposed R127. Python guide-builder syntax parsed. No source changes justified rerunning application tests, lint, types or native builds. No network link check, package/install test or asset provenance/legal review claimed. Temporary inspection metadata/contact sheets are under `/tmp/oarlock-review30-*`; the repository assets were not modified.

Stopped at **30 DONE / 5 TODO / 0 FROZEN sections; 1199 reviewed / 551 TODO / 0 FROZEN files**, with all 1,750 inventory paths unique. Only REVIEW_LEDGER.md changed this turn. Neither section exceeded the previous maximum and no source file was edited. Next in ledger order: F1 (AI/MCP and supporting code), then F2 (previews); wait for authorization.

Checkpoint 18: authorized F1–F2 under the same rules. F1 contains 437 files and could not receive an honest complete breadth pass within the existing time ceiling. Inspected the first seven files in ledger order, with representative control-flow/test sampling for larger files. Remaining symbol inventories and test execution do not count as source coverage. F1 stays TODO with seven individually DONE paths and 430 unread paths; F2 was not started. No previously DONE section reopened, architecture proposal, source edit, or new test. R130 and R131 are recorded with source-only evidence limits; no claim of executed reproduction.

Validation: F1's existing frontend selection initially passed 164/165 files and 1,368/1,369 tests; the remaining offline-transcription redirect test timed out after its local HTTP listener could not start in the restricted run. Rerunning that file with local listener access passed all 20 tests. No remaining test failure established; this is not native, live-app or full-repository certification. Initial log: `/tmp/oarlock-sectionF1-tests.log`; successful retry output is in this conversation. No fixes, so no new tests or full lint/types/Clippy run.

Stopped at **30 DONE / 5 TODO / 0 FROZEN sections; 1206 reviewed / 544 TODO / 0 FROZEN files**. Only this ledger changed. Next unread F1 path: `src-tauri/src/modules/ai_endpoints.rs`. Wait for authorization before continuing the unfinished section; do not repeat its seven DONE paths or skip to F2.

Checkpoint 19: user authorized continuation under the same procedure. Resumed F1 at `ai_endpoints.rs` and reviewed the next 26 paths through `mcp/oauth/discovery.rs`. F1 now has **33/437 individually DONE paths**, with **404 unread**. F2 was not started because F1 remains unfinished. Inspection sampled request/transaction entry points, persistence and cancellation paths, platform branches, parsing and representative tests in large files; it is not line-by-line certification. Symbol-only inventories and truncated/unseen output were not counted as coverage. No DONE path from checkpoint 18 or any earlier section was reopened. Seven findings recorded: one BLOCKER, five MAJOR, one MINOR. All remain log-only with reproduction limits; no architecture proposal or implementation in this breadth pass.

Validation: **88 native tests passed**: 54 AI persistence/lifecycle tests, plus MCP credentials 8, framing 8, logs 8, status 5 and storage 5. The initial `--lib` selection matched zero tests and is not counted; the corrected selection exercised the application tests. Logs: `/tmp/oarlock-sectionF1-native19.log`, `/tmp/oarlock-sectionF1-mcp19.log`. No real keychain edits, network stress, blocked-pipe reproduction, Windows run, full frontend suite, lint, type check or Clippy certification. No new tests because no source fix was made.

Stopped at **30 DONE / 5 TODO / 0 FROZEN sections; 1232 reviewed / 518 TODO / 0 FROZEN files**. Only this ledger changed. F1 continuation took 209 seconds, below the established 213-second ceiling and five-minute cap. Next unread file: `src-tauri/src/modules/mcp/oauth/fetch.rs`. Wait for authorization before continuing; retain the completed files as DONE and do not skip ahead to F2. AP001/AP002 remain deferred; K001 remains log-only.

Checkpoint 20: resumed F1 at `mcp/oauth/fetch.rs`; reviewed the next 24 paths through `shell/session_registry.rs`. F1 now has **57/437 individually DONE paths**, with **380 unread**. Larger sources received representative implementation/control-flow and test sampling, not exhaustive line-by-line inspection. Read the OAuth request/discovery/token handling, native network budgets and ownership, secret-file/generation publication, and shell job/session lifetimes. No completed path or section was reopened. F2 remains unstarted because F1 is incomplete. Five MAJOR findings are recorded above with source-evidence and reproduction limits; no new BLOCKER, architecture proposal, fix or test added.

Validation: **147 native tests passed**, comprising 62 OAuth tests and 85 network tests, using local HTTP fixtures where applicable. Logs: `/tmp/oarlock-sectionF1-oauth20.log`, `/tmp/oarlock-sectionF1-net20.log`. These existing tests do not reproduce the newly logged cases. No real-provider/keychain mutation, resource stress, Windows runtime test, full frontend suite, lint/types or Clippy certification. Source review ended at 22:43:48 UTC after 196 seconds; subsequent ledger bookkeeping is administrative.

Stopped at **30 DONE / 5 TODO / 0 FROZEN sections; 1256 reviewed / 494 TODO / 0 FROZEN files**. Only this ledger changed. Next unread path: `src-tauri/src/modules/skills/discover.rs`. Wait for authorization before continuing F1; F2 follows only when F1 is complete. AP001/AP002 remain deferred and K001 remains log-only.

Checkpoint 21: resumed F1 at `skills/discover.rs` and reviewed the next 52 paths through `ai/components/AiInputBar.tsx`. F1 now has **109/437 individually DONE paths**, with **328 unread**; F2 remains unstarted. Inspected skill discovery/read/install/settings/watch paths, shared chat display and network-page helpers, agent launcher/notifications/stores, model-resolution helpers, subagent wrappers, and the first chat/composer components. Large files received representative source and test sampling; truncated/unseen portions and symbol-only listings were not counted as separately reviewed files. Provider catalog prices/availability were not externally verified. Previously completed product sections were not re-reviewed; package test-script configuration was consulted only to correct the validation invocation.

Thirteen findings recorded: one BLOCKER (R148, fixed), eleven MAJOR and one MINOR. R148 is the only source fix: 8 added lines and 1 removed line across `agents/lib/format.ts` and its test, within F1. A pre-fix regression returned an object for `__proto__`; the corrected implementation accepts only own properties. The initial `Object.hasOwn` spelling failed the project's type target, so the second and final implementation edit uses `Object.prototype.hasOwnProperty.call`. Edit counts: implementation 2, test 1; no third source edit. No new abstraction, public/native interface, data model or architecture proposal.

Validation: 58 native skill tests passed. The focused UI selection passed 76 tests. Full `bun run test` passed 5,423/5,425 tests across 582/584 files; the remaining two tests could not open local HTTP listeners in the restricted run. A first listener-enabled retry used `bun x vitest`, which ran the wrong runtime for the Bun-FFI app-lab suite; this is not counted as a product failure. Corrected `bun run test` retry passed all 30 tests across the app-lab, transcription and new regression files. Final `bun run lint`, `bun run check-types` and scoped diff whitespace checks passed. No remaining test failure established, but no full-suite single-run clean result claimed. Logs: `/tmp/oarlock-sectionF1-skills21.log`, `/tmp/oarlock-sectionF1-ui21-fixed.log`, `/tmp/oarlock-review21-tests.log`, `/tmp/oarlock-review21-retry-bun.log`, `/tmp/oarlock-review21-types-fixed.log`, `/tmp/oarlock-review21-lint-final.log`. No Rust source change, full native suite/Clippy run, live-provider test or cross-platform certification.

Stopped at **30 DONE / 5 TODO / 0 FROZEN sections; 1308 reviewed / 442 TODO / 0 FROZEN files** after 194 seconds. Changed only the ledger and the two R148 files during this continuation; prior worktree changes were preserved. Next unread path: `src/modules/ai/components/AiMiniWindow.tsx`. Wait for authorization before continuing F1; retain completed paths as DONE. AP001/AP002 remain deferred; K001 remains log-only.

Checkpoint 22: latest user authorization increases each section cap to ten minutes, superseding the historical 213-second ceiling. Resumed F1 at AiMiniWindow.tsx and inspected the next **173 paths**, through tools/tools.ts. F1 now has **282/437 DONE paths**, **155 unread**; F2 remains unstarted. This was one breadth pass with representative source/test sampling for large files, not exhaustive inspection of every line. Unseen truncated output was not counted as independent file coverage. No previously DONE section was reopened.

Recorded R157–R175 (19 findings: 2 BLOCKER, 15 MAJOR, 2 MINOR). Only R168 fixed, within F1 and under 50 added lines including its regression. Source edit counts this continuation: planStore.ts once, planStore.failures.test.ts twice (test creation then formatting); no third edit. Existing changes in those files were preserved. AP003 stops the pass before any cross-section/native-interface change. No commit or push.

Validation: the deferred-validation regression demonstrated the rejected edit still writing before the fix. Afterward the full frontend suite passed **5,426 tests in 584 files** using Bun with local-listener permission. Earlier AI-library selection passed 559 tests. Type checks passed; lint passed with 80 existing warnings. No Rust changed; full Rust suite/Clippy and cross-platform/live-provider testing were not repeated. Production hash probe confirms R170 with Aa/B@. Logs: /tmp/oarlock-review22-repro.log, /tmp/oarlock-review22-full.log, /tmp/oarlock-review22-types.log, /tmp/oarlock-review22-lint.log, /tmp/oarlock-review22-tests.log.

Unconfirmed leads retained for depth, not asserted as additional defects: hosted SDK constructors omit explicit proxyFetch (global fetch installation was not re-reviewed); error-text redaction coverage for provider-specific key formats; ordinary-object approval input assumptions; folder-reference backtick formatting; endpoint preset matching of case-sensitive paths; stop behavior of delayed managed-agent submission; migration handling of invalid legacy entries. These need caller/native/context validation before severity assignment. No external provider facts were checked.

Checkpoint: **30 DONE / 5 TODO / 0 FROZEN sections; 1481 reviewed / 269 TODO / 0 FROZEN files**. Next unread: src/modules/editor/lib/autocomplete/configuration.test.ts. Wait for the user's AP003 decision and continuation authorization. AP001/AP002 remain deferred; K001 log-only.

Checkpoint 23: continued in ledger order with a ten-minute cap for each section. Before work, stated that continuation would be treated as deferring AP003 to the depth phase, without permission to implement it. Completed the remaining **155 F1 paths** and all **62 F2 paths**: **217 newly reviewed paths**. F1 and F2 are DONE, meaning one breadth pass with representative implementation/control-flow and test sampling for large files, not exhaustive line-by-line certification. Truncated output was fetched in smaller batches where needed; unseen sections of large files are not claimed as inspected. Read the removed MarkdownPreviewPane.test.ts from the PR base (absent from HEAD); its static-mode assertions have successors in RenderedMarkdown.test.tsx. F3–F5 were not opened.

Recorded **R176–R195: 3 BLOCKER, 14 MAJOR, 3 MINOR**. R176 and R194 alone were fixed, each confined to its own section and under approximately 50 changed/added lines including regression coverage. Both fixes preserve the existing interfaces and data model; no abstraction or native API was added. R189 is source-confirmed but not a live exploit reproduction; its resolution is left to depth, without implementing or prescribing a new boundary. AP001/AP002 remain deferred, AP003 remains an unresolved release blocker, and K001 remains log-only. No commit or push.

Validation: the two MCP form regressions and both UNC-path cases failed before their respective fixes. Final full frontend suite passed **5,430 tests in 584 files**; type checks passed; lint passed with **80 existing warnings**. The initial restricted full run could not open local test servers (two failures/one listener error); the authorized rerun passed, as did the final rerun after the F2 fix. No native code was edited, and Rust/Clippy, real Windows network shares, platform webviews, live MCP servers and paid AI calls were not tested this turn. Existing unrelated local changes were preserved, including nine preexisting added lines in localImages.test.tsx. Each implementation received one edit; each test received two (addition then formatting), with no third source edit. Logs: /tmp/oarlock-review23-repro.log, /tmp/oarlock-review23-targeted.log, /tmp/oarlock-review23-unc-repro.log, /tmp/oarlock-review23-unc-fixed.log, /tmp/oarlock-review23-probes.log, /tmp/oarlock-review23-final-tests.log, /tmp/oarlock-review23-final-types.log, /tmp/oarlock-review23-final-lint.log.

Unconfirmed leads retained for depth, not asserted as additional defects: autocomplete's lack of a caller timeout versus native request deadlines; MCP composer preparation cancellation while shared server startup continues; sampling choices retained while endpoint settings change; credential recovery buttons lacking local busy/error handling; preview normalizeUrl accepting arbitrary schemes/relative strings and its interaction with iframe/CSP/native navigation policy; JSON.stringify used as CSS-selector escaping for heading fragments; recursive Markdown visitors on deeply nested trees. A 200,000-line frontmatter probe completed successfully in Bun, so the suspected spread-argument failure was not established and was not fixed. No previously DONE product section was reopened for implementation; final test execution exercised existing code beyond the active sections as regression validation only.

Checkpoint: **32 DONE / 3 TODO / 0 FROZEN sections; 1698 reviewed / 52 TODO / 0 FROZEN files**. Remaining: F3 XML/language overrides (13), F4 theme storage (14), F5 shared integration (25). Stop and wait for the user's next authorization. No new architecture proposal or implementation question at this checkpoint.

Checkpoint 24: reviewed F3 then F4 with the user-authorized ten-minute cap per section. Completed all **27 preexisting paths** plus **one new regression-test path**. F3 is DONE (14/14); F4 is DONE (14/14). Read the language helpers/tests and theme files; sampled changed command, range, search continuation, input, lifecycle and structural-tag paths of the 7,376-line Vim core and 1,755-line adapter. Large forks received a breadth/control-flow pass, not exhaustive line-by-line certification or a fresh full browser compatibility corpus. Read both review probes and all assigned theme implementations/tests. Relevant AGENTS.md instructions were consulted as instructions, not counted as F5 review. No F5 product code reviewed.

Recorded **R196–R209: 1 BLOCKER, 8 MAJOR, 5 MINOR**. Only R196 was fixed. The core and its new test each received two edits; neither was edited a third time. F4 had no source edits. The new test belongs to F3 and increases the local supplemental inventory from 499 to 500 paths (1751 total). Existing unrelated working-copy changes were preserved. No commits, pushes, abstraction changes, public/native interface changes or new architecture proposal. AP001/AP002/AP003 remain deferred; K001 (Windows theme safe writes) remains log-only and was not fixed.

Validation: the two first-line sort cases failed before changing their defaults; the separate first-line global case also failed before fixing that endpoint. Final F3 targeted suite: **224 tests in five files**. F4: **27 frontend tests in four files**, plus **eight native themes tests** against temporary files on this macOS host. Final full frontend suite: **5,435 tests in 585 files passed**. Type checks passed; lint passed with **80 existing warnings**. The initial restricted full run had two failures and one local HTTP-listener error; rerunning with authorized local-network access passed. No Rust production change, full Rust suite or Clippy run. No live Windows/Linux, WSL, terminal LazyVim or WebView corpus execution. Headless adapter tests exercise actual Ex parsing/range behavior with an in-memory CodeMirror state, not browser layout. Logs: /tmp/oarlock-review24-range-before.log, /tmp/oarlock-review24-global-before.log, /tmp/oarlock-review24-f3-fixed.log, /tmp/oarlock-review24-f4-tests.log, /tmp/oarlock-review24-native-themes.log, /tmp/oarlock-review24-types.log, /tmp/oarlock-review24-lint.log, /tmp/oarlock-review24-all-tests.log, /tmp/oarlock-review24-all-tests-unrestricted.log.

Unconfirmed leads retained for depth, not asserted as additional defects: theme IDs colliding with built-in IDs and the default-theme special case; delayed companion-file deletion after re-creation (deleteThemeFile also suppresses every error); native/frontend theme schema drift; missing cross-window acknowledgement of theme edit handoff; Vim adapter indentLine ignoring its line parameter and the semantics of cancelled partially completed substitution. The multi-option :set probe could not complete in the minimal headless harness; no result was fabricated. Previously DONE files were not reopened for implementation; the full test suite is regression validation only.

Checkpoint: **34 DONE / 1 TODO / 0 FROZEN sections; 1726 reviewed / 25 TODO / 0 FROZEN files**. Only F5 shared integration (25 files) remains. Stop and wait for the user's continuation authorization. No new architecture question.

Checkpoint 25: completed F5's **25/25 assigned paths** in 330 seconds, within the ten-minute cap. Reviewed native registration/startup/cleanup, store guarding, formatter execution, App handoffs, editor document/save/mount wiring, LSP attachment, status/input components and terminal activity. Read representative tests and ran the assigned focused suites. Large App/EditorPane files, the 1,539-line document test suite and the long living/historical architecture documents received control-flow/changed-area sampling; DONE means each listed path received a breadth pass, not every line or historical claim independently verified. No previously DONE section reopened.

Recorded **R210–R221: 0 new BLOCKER, 8 MAJOR, 4 MINOR**. All remain logged, with source evidence and explicit reproduction limits. No code fixes, tests added, new abstractions, model/interface changes, architecture proposals, commits or pushes. Only this ledger changed during the turn. AP001/AP002/AP003 remain deferred; K001 stays log-only.

Validation: **107 frontend tests in seven files passed**. Native focused suites: formatter **5**, store_scope **8**, agent_detect **30**, launch_target_tests **12**; **55 native tests passed** in total on this macOS host. Existing tests validate their covered invariants, not the newly logged race hypotheses. No full frontend/native suite, lint/type/Clippy rerun was needed for this documentation-only review; no fresh full-suite or Windows/Linux/WSL runtime certification is claimed. Logs: `/tmp/oarlock-review25-{frontend,formatter,store,agents,launch}.log`.

Unconfirmed leads retained for depth, not asserted as additional defects: ordinary autosave goes directly to saveNow rather than EditorPane's formatter path (desired autosave-format policy unestablished); SettingsApp does not itself catch/init-gate preferences, but store-level recovery could handle this; same-ID custom LSP configuration changes rely on runtime generation updates outside this section; delayed agent launch waits need a separate terminal-generation check; agent-activity event scoping/replay needs native-emission evidence; LaunchFiles has an unbounded vector and linear deduplication, but practical admission limits were not established. Custom formatter commands are user-selected executables: rejecting a few in-place flags is not evidence of general process isolation, and no such guarantee is claimed here.

Coverage qualification: primary inventory is **35 DONE / 0 TODO / 0 FROZEN sections; 1751 reviewed / 0 TODO / 0 FROZEN files**. The auxiliary rename-source inventory still has **three TODO old/remove-side names** belonging to sections 23 and 25. Their counterpart sections were previously marked DONE, but this ledger does not establish that the old sides were inspected. They are excluded from the unique-file count and have not been silently marked reviewed. Resolving that administrative/coverage gap requires explicit follow-up permission to inspect those old sides; those sections were not reopened now.

Stop at checkpoint 25. No new architecture decision requested; no depth work started.

Checkpoint 26: user explicitly authorized only the three outstanding old/remove-side names, with a ten-minute total cap. Completed their comparison in **108 seconds**. Read the removed sources from PR base `5502f826a6476556182ddbe1466ec2ba94c0fd47`, reviewed rename-aware base-to-head changes and the current counterparts. Those three counterpart files have no working-copy changes relative to published head `577ccc9ed0ffc497be4b2ee15b42d2a0592c03ac`. Checked direct build/export/registry references narrowly; this was not a new pass over sections 23 or 25.

- `terax.zig` → `oarlock.zig`: old source 3,350 lines, new source 4,679. Inspected old lifecycle/render/reply paths and removed/replaced diff regions, including color-response delegation, clipboard events, shell markers, graphics placement and glyph-table changes. All **120 old exported function names remain**, with 23 added. The removed custom colorOperation function is replaced by upstream handler routing; existing actual-WASM query tests pass. The output truncation behavior already logged as R095 exists in the base source too; this comparison does not establish it as a newly introduced fork regression. Large unchanged/new regions were sampled, not exhaustively re-audited.
- `TeraxGhostty.ts` → `OarlockGhostty.ts`: old source 1,835 lines, new source 2,445. Inspected old load/create/dispose/memory ownership plus rename, event and ABI diffs. The declaration-name comparison found no removed adapter method names; class/type names intentionally change with the private package branding. Build/package exports point at the new names. Both shipped SIMD/scalar WASM SHA-256 values match the current adapter constants. This is a consistency check, not a source-to-binary reproducibility proof.
- `terax-default.ts` → `oarlock-default.ts`: read the complete 18-line old source and full diff. Only export name, theme ID and display name change; variants, description and editor-theme pairing remain. The builtin registry imports the replacement and default-theme lookup tests pass. No stale production references to these removed source names were found in the scoped reference search; persisted third-party consumers were not tested.

**New findings: 0 BLOCKER / 0 MAJOR / 0 MINOR / 0 NIT.** No architecture proposal, code fix or new test. Existing findings and deferred AP001/AP002/AP003 remain unchanged; K001 remains log-only. Only this ledger was edited. No commits or pushes.

Validation: **213 tests passed in six files**: AdaptedGhostty, AdaptedGhosttyGpu, coreCompatibility, AdaptedLoader, builtin-theme index and bundled themes. These execute current shipped WASM and cover relevant cursor/query/render/load/default-theme behavior. No WASM rebuild, live GUI/platform test or full-suite/lint/type/Clippy rerun. Log: `/tmp/oarlock-review26-tests.log`; comparison diffs: `/tmp/oarlock-review26-{adapter,core}.diff`. A final narrow grep used two nonexistent optional paths and returned an error; the earlier repository search and the corrected existing-path search supply the reference evidence, not that failed invocation.

Checkpoint: **35 DONE / 0 TODO / 0 FROZEN sections; 1751 reviewed / 0 TODO / 0 FROZEN primary files; 6/6 auxiliary rename-source entries DONE**. Counts of unique PR/local paths remain unchanged. The auxiliary gap reported at checkpoint 25 is closed. Coverage means one bounded breadth pass, not release certification. Stop here; no further review or depth work authorized. No questions or architecture decisions pending from this checkpoint.

## Per-file coverage


Checkpoint 6: user authorized sections 07–08 only, five minutes each. Both are DONE for breadth; 8 DONE / 22 TODO / 5 FROZEN sections, 187 reviewed / 1017 TODO / 545 FROZEN files. No frozen inventory path was opened or edited; frozen responsibilities encountered in mixed files were excluded from analysis. No new architecture proposal; AP001 remains deferred. No source file edited more than twice, no section-08 fixes, no commits/pushes. Stop here and await the user before section 09.

Fix R015: `src/modules/spaces/lib/restoreGrants.ts` retains the existing immediate/deferred grant model but scopes duplicate detection to the existing deferred space owner. The existing `restoreGrants.test.ts` gained three parametrized cases. All three failed before correction; afterward the full frontend suite passed. Total diff: 23 additions / 2 deletions across production and test; no new abstraction, interface or data model. Source edited once, test twice including formatting; neither may receive another edit in this pass.

Validation: types passed; lint passed with 79 existing warnings; **5,423 frontend tests / 583 files passed**; Clippy all targets with warnings denied passed; **1,540 native tests passed, 3 ignored**. Existing focused section-07 tests: 187 passed / 25 files before the three added cases. Scoped formatting and whitespace checks passed. Full checks validate the working tree, not unperformed platform/UI reproductions. Logs: `/tmp/oarlock-coverage07-{types,lint,tests-full,clippy,native}.log`; failing-before evidence: `/tmp/oarlock-coverage07-before.log`.

Checkpoint 7: user authorized sections 09–10 only, five minutes each, and asked whether findings are recorded. All coverage-phase findings are in the register; older pre-ledger review history is not silently counted as completed breadth coverage. Counts: **10 DONE / 20 TODO / 5 FROZEN sections; 217 reviewed / 983 TODO / 549 FROZEN files**. Total inventory remains 1,749 paths. Four misclassified paths were moved to existing frozen groups: three preview paths and one dedicated content-import policy. Initial reads exposed the mismatch in three of these; no continued investigation or edits followed. The fourth, assetUrl.test.ts, was not opened. Frozen branches in mixed files were excluded; no previously frozen inventory path was opened. No source edits, fixes, new tests, architecture proposal, commit or push. Stop before section 11 and await the user.

Validation: **11 workspace frontend tests passed / 3 files**. **30 workspace native tests passed** after correcting an initial filter that selected zero tests (AI-specific cases excluded). Section-10 focused native suites passed: saves 15, mutations 20, destination ownership 11, ACL 2, copy 12, recovery events 10 (**70 tests**). Copy's first restricted run had 11 passes and one fixture failure creating a Unix socket; the authorized unrestricted rerun passed all 12. No full-suite rerun or new Windows/Linux validation claimed for this ledger-only turn. Logs: `/tmp/oarlock-coverage09-{frontend,native-checked}.log`, `/tmp/oarlock-coverage10-{saves,mutate,destination,access_control,copy-retry,events}.log`. No new failure is being hidden by the successful retry; the original fixture error remains in `/tmp/oarlock-coverage10-copy.log`.

### 01 — Updater

Status: **DONE**. Review time: 23 seconds. Source edits: 0. Findings: R001, R002.

#### `src/modules/updater/` — DONE (4 files)

- DONE `src/modules/updater/UpdaterDialog.tsx` — PR+LOCAL
- DONE `src/modules/updater/index.ts` — PR
- DONE `src/modules/updater/updater.test.ts` — PR
- DONE `src/modules/updater/useUpdater.ts` — PR

Inspection: all four current files and their base-to-working-copy changes. Existing disabled-updater/configuration tests passed (2). No native install or live download exercised because updates are disabled.

### 02 — OS privacy and permissions UI

Status: **DONE**. Review time: initial pass stopped at the 23-second baseline; authorized continuation completed in 25 seconds, within its five-minute cap. Source edits: 0. Findings: R003 (MINOR).

#### `src-tauri/src/modules/` — DONE (1 files)

- DONE `src-tauri/src/modules/mac_privacy.rs` — PR

#### `src-tauri/tests/` — DONE (1 files)

- DONE `src-tauri/tests/color_scheme_portal.rs` — PR

#### `src/modules/mac-privacy/` — DONE (12 files)

- DONE `src/modules/mac-privacy/PrivacyRefusal.tsx` — PR
- DONE `src/modules/mac-privacy/explain.ts` — PR
- DONE `src/modules/mac-privacy/fileErrors.test.ts` — PR
- DONE `src/modules/mac-privacy/fileErrors.ts` — PR
- DONE `src/modules/mac-privacy/firstRun.test.ts` — PR
- DONE `src/modules/mac-privacy/firstRun.ts` — PR
- DONE `src/modules/mac-privacy/index.ts` — PR
- DONE `src/modules/mac-privacy/infoPlist.test.ts` — PR
- DONE `src/modules/mac-privacy/native.ts` — PR
- DONE `src/modules/mac-privacy/useFullDiskAccess.ts` — PR
- DONE `src/modules/mac-privacy/useFullDiskAccessSuggestion.test.ts` — PR
- DONE `src/modules/mac-privacy/useFullDiskAccessSuggestion.ts` — PR

#### `src/modules/mac-privacy/lib/` — DONE (7 files)

- DONE `src/modules/mac-privacy/lib/areas.test.ts` — PR
- DONE `src/modules/mac-privacy/lib/areas.ts` — PR
- DONE `src/modules/mac-privacy/lib/operationNotPermitted.ts` — PR
- DONE `src/modules/mac-privacy/lib/refusal.test.ts` — PR
- DONE `src/modules/mac-privacy/lib/refusal.ts` — PR
- DONE `src/modules/mac-privacy/lib/suggestion.test.ts` — PR
- DONE `src/modules/mac-privacy/lib/suggestion.ts` — PR

#### `src/settings/sections/` — DONE (1 files)

- DONE `src/settings/sections/MacPrivacySettings.tsx` — PR

Inspection: all 22 files read in full for breadth, including the three previously truncated/unread files. Focused frontend/native tests passed (45 + 8). The Linux portal fixture received source inspection only; no real protected files were probed and no OS permission was changed. Dependencies in other sections were not followed. No additional BLOCKER/MAJOR findings or fixes. This is a completed breadth pass, not exhaustive OS integration validation.

### 03 — CLI and external control

Status: **DONE**. Review time: 79 seconds, within the authorized five-minute cap. Source edits: 0. Findings: R004, R005; AP001 deferred to depth by the user.

#### `scripts/` — DONE (1 files)

- DONE `scripts/build-cli.mjs` — PR+LOCAL

#### `src-tauri/crates/oarlock-cli/` — DONE (1 files)

- DONE `src-tauri/crates/oarlock-cli/Cargo.toml` — PR

#### `src-tauri/crates/oarlock-cli/src/` — DONE (1 files)

- DONE `src-tauri/crates/oarlock-cli/src/main.rs` — PR+LOCAL

#### `src-tauri/crates/oarlock-control-protocol/` — DONE (1 files)

- DONE `src-tauri/crates/oarlock-control-protocol/Cargo.toml` — PR

#### `src-tauri/crates/oarlock-control-protocol/src/` — DONE (1 files)

- DONE `src-tauri/crates/oarlock-control-protocol/src/lib.rs` — PR+LOCAL

#### `src-tauri/crates/terax-control-protocol/` — DONE (1 files)

- DONE `src-tauri/crates/terax-control-protocol/Cargo.toml` — PR; deleted/missing in working copy

#### `src-tauri/src/modules/` — DONE (1 files)

- DONE `src-tauri/src/modules/control.rs` — PR+LOCAL

#### `src/modules/control/` — DONE (2 files)

- DONE `src/modules/control/useControlBridge.lifecycle.test.ts` — LOCAL-ONLY
- DONE `src/modules/control/useControlBridge.ts` — PR+LOCAL

#### `src/modules/control/lib/` — DONE (1 files)

- DONE `src/modules/control/lib/context.ts` — PR

Inspection: all 10 listed paths inspected (current content for existing files; base content for the deleted manifest). Rename metadata checked for the old CLI/protocol paths against their current counterparts; protocol source rename is unchanged at PR head. No frozen dependency followed. Focused checks: 3 frontend + 39 native tests passed. No fix or new regression test.

### 04 — Shortcuts and native menus

Status: **DONE**. Review time: 175 seconds including validation, within the authorized five-minute cap. Source edits: 2 files, one edit each (11 added lines total). Findings: R006 fixed; R007 logged.

#### `src-tauri/src/modules/` — DONE (2 files)

- DONE `src-tauri/src/modules/app_menu.rs` — PR
- DONE `src-tauri/src/modules/menu_shortcuts.rs` — PR

#### `src/modules/shortcuts/` — DONE (3 files)

- DONE `src/modules/shortcuts/index.ts` — PR
- DONE `src/modules/shortcuts/shortcuts.test.ts` — PR
- DONE `src/modules/shortcuts/shortcuts.ts` — PR

#### `src/modules/shortcuts/lib/` — DONE (11 files)

- DONE `src/modules/shortcuts/lib/menuBridge.lifecycle.test.ts` — LOCAL-ONLY
- DONE `src/modules/shortcuts/lib/menuBridge.ts` — PR+LOCAL
- DONE `src/modules/shortcuts/lib/menuShortcuts.test.ts` — PR
- DONE `src/modules/shortcuts/lib/menuShortcuts.ts` — PR
- DONE `src/modules/shortcuts/lib/shortcutLabel.test.ts` — PR
- DONE `src/modules/shortcuts/lib/shortcutLabel.ts` — PR
- DONE `src/modules/shortcuts/lib/shortcutScope.test.ts` — PR
- DONE `src/modules/shortcuts/lib/shortcutScope.ts` — PR
- DONE `src/modules/shortcuts/lib/useGlobalShortcuts.ts` — PR
- DONE `src/modules/shortcuts/lib/useMenuShortcuts.ts` — PR
- DONE `src/modules/shortcuts/lib/useShortcutLabel.ts` — PR

#### `src/settings/sections/` — DONE (1 files)

- DONE `src/settings/sections/ShortcutsSection.tsx` — PR

Inspection: all 17 files inspected for non-frozen shortcut/menu behavior. AI/preview action identifiers in shared registries were treated as opaque; their feature code remained frozen. See checkpoint 4 for the small fix and validation. No native-window manual validation; R007 remains a source-level finding.

### 05 — Explorer and file navigation

Status: **DONE**. Review time: 160 seconds (20:21:41–20:24:21 UTC), within five-minute cap. Source edits: 0. Findings: R008–R010.

#### `src/modules/explorer/` — DONE (6 files)

- DONE `src/modules/explorer/ExplorerSearch.tsx` — PR
- DONE `src/modules/explorer/FileExplorer.tsx` — PR+LOCAL
- DONE `src/modules/explorer/FileIcon.tsx` — PR
- DONE `src/modules/explorer/InlineInput.tsx` — PR
- DONE `src/modules/explorer/TreeRow.test.tsx` — PR
- DONE `src/modules/explorer/TreeRow.tsx` — PR

#### `src/modules/explorer/lib/` — DONE (20 files)

- DONE `src/modules/explorer/lib/clipboardPaste.test.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/clipboardPaste.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/contextActions.test.ts` — LOCAL-ONLY
- DONE `src/modules/explorer/lib/contextActions.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/iconResolver.ts` — PR
- DONE `src/modules/explorer/lib/openDefault.test.ts` — PR
- DONE `src/modules/explorer/lib/openDefault.ts` — PR
- DONE `src/modules/explorer/lib/refreshTargets.test.ts` — PR
- DONE `src/modules/explorer/lib/refreshTargets.ts` — PR
- DONE `src/modules/explorer/lib/treePaths.test.ts` — PR
- DONE `src/modules/explorer/lib/treePaths.ts` — PR
- DONE `src/modules/explorer/lib/useExplorerDnd.test.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/useExplorerDnd.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/useExplorerFileDrop.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/useFileTree.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/watch.test.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/watch.ts` — PR+LOCAL
- DONE `src/modules/explorer/lib/watchHealth.ts` — LOCAL-ONLY
- DONE `src/modules/explorer/lib/watchHealthState.test.ts` — LOCAL-ONLY
- DONE `src/modules/explorer/lib/watchHealthState.ts` — LOCAL-ONLY

Inspection: all 26 current files received one breadth pass. AI attachment callbacks were opaque; no frozen implementation was followed. Existing Explorer tests: **111 passed / 15 files**. No live-window reproduction, new test, product fix or architecture proposal. Findings below are source-level risks for depth review, not claims of demonstrated data loss.

### 06 — Project search, command palette and sidebar

Status: **DONE**. Review time: 150 seconds (20:24:52–20:27:22 UTC), within five-minute cap; final ledger/checkpoint administration afterward. Source edits: 2 files, 2 edits each. Findings: R011–R013.

#### `src-tauri/src/modules/fs/` — DONE (3 files)

- DONE `src-tauri/src/modules/fs/grep.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/search.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/supersede.rs` — PR

#### `src-tauri/tests/` — DONE (1 files)

- DONE `src-tauri/tests/fs_search.rs` — PR

#### `src/modules/command-palette/` — DONE (5 files)

- DONE `src/modules/command-palette/CommandPalette.tsx` — PR+LOCAL
- DONE `src/modules/command-palette/ThemeItem.test.tsx` — PR
- DONE `src/modules/command-palette/ThemeItem.tsx` — PR
- DONE `src/modules/command-palette/commands.test.ts` — PR
- DONE `src/modules/command-palette/commands.ts` — PR

#### `src/modules/command-palette/hooks/` — DONE (8 files)

- DONE `src/modules/command-palette/hooks/authorizeContentHit.test.ts` — LOCAL-ONLY
- DONE `src/modules/command-palette/hooks/authorizeContentHit.ts` — LOCAL-ONLY
- DONE `src/modules/command-palette/hooks/requestContentSearch.test.ts` — LOCAL-ONLY
- DONE `src/modules/command-palette/hooks/requestContentSearch.ts` — LOCAL-ONLY
- DONE `src/modules/command-palette/hooks/useAsyncQuery.test.ts` — LOCAL-ONLY
- DONE `src/modules/command-palette/hooks/useAsyncQuery.ts` — PR+LOCAL
- DONE `src/modules/command-palette/hooks/useCommandHistory.ts` — PR
- DONE `src/modules/command-palette/hooks/useContentSearch.ts` — PR+LOCAL

#### `src/modules/command-palette/lib/` — DONE (2 files)

- DONE `src/modules/command-palette/lib/mru.ts` — PR+LOCAL
- DONE `src/modules/command-palette/lib/mru.test.ts` — LOCAL-ONLY (unchanged in published PR; existing tests extended during this pass)

#### `src/modules/sidebar/` — DONE (6 files)

- DONE `src/modules/sidebar/SidebarRail.tsx` — PR
- DONE `src/modules/sidebar/index.ts` — PR
- DONE `src/modules/sidebar/sidebarPosition.test.ts` — PR
- DONE `src/modules/sidebar/sidebarPosition.ts` — PR
- DONE `src/modules/sidebar/types.ts` — PR
- DONE `src/modules/sidebar/useSidebarPanel.ts` — PR

#### `src/modules/sidebar/search/` — DONE (4 files)

- DONE `src/modules/sidebar/search/ContentSearchView.tsx` — PR+LOCAL
- DONE `src/modules/sidebar/search/ContentSearchViewLazy.tsx` — PR
- DONE `src/modules/sidebar/search/contentSearchResults.test.ts` — PR
- DONE `src/modules/sidebar/search/contentSearchResults.ts` — PR

Inspection: all 28 original paths received their non-frozen breadth pass; the existing MRU test file became the 29th supplemental path when extended for R012. Theme storage/snapshot hooks and AI/preview action callbacks in shared palette files were treated as opaque, with no frozen implementation inspected or changed. The shared native search functions were assessed only for non-AI search behavior; AI callers and authorization policy were not followed. No later section reopened or started.

### 07 — Tabs and spaces

Status: **DONE**. Review time: 128 seconds (20:29:56–20:32:04 UTC), within five-minute cap. Source edits: restoreGrants.ts once; restoreGrants.test.ts twice including formatting. Findings: R014–R018.

#### `src/modules/spaces/` — DONE (2 files)

- DONE `src/modules/spaces/SpaceSwitcher.tsx` — PR+LOCAL
- DONE `src/modules/spaces/index.ts` — PR

#### `src/modules/spaces/components/` — DONE (1 files)

- DONE `src/modules/spaces/components/InlineRename.tsx` — PR

#### `src/modules/spaces/lib/` — DONE (14 files)

- DONE `src/modules/spaces/lib/activeSpace.test.ts` — PR
- DONE `src/modules/spaces/lib/activeSpace.ts` — PR
- DONE `src/modules/spaces/lib/openFolder.test.ts` — PR
- DONE `src/modules/spaces/lib/openFolder.ts` — PR
- DONE `src/modules/spaces/lib/restoreGrants.test.ts` — PR+LOCAL
- DONE `src/modules/spaces/lib/restoreGrants.ts` — PR+LOCAL
- DONE `src/modules/spaces/lib/serialize.test.ts` — PR
- DONE `src/modules/spaces/lib/serialize.ts` — PR
- DONE `src/modules/spaces/lib/store.test.ts` — PR
- DONE `src/modules/spaces/lib/store.ts` — PR
- DONE `src/modules/spaces/lib/useSpacePersistence.ts` — PR
- DONE `src/modules/spaces/lib/useSpaces.ts` — PR
- DONE `src/modules/spaces/lib/useSpacesBoot.test.ts` — PR
- DONE `src/modules/spaces/lib/useSpacesBoot.ts` — PR

#### `src/modules/tabs/` — DONE (5 files)

- DONE `src/modules/tabs/NewTabMenu.tsx` — PR
- DONE `src/modules/tabs/TabBar.tsx` — PR
- DONE `src/modules/tabs/TabMoveMenus.tsx` — PR
- DONE `src/modules/tabs/TerminalTabLabel.tsx` — PR
- DONE `src/modules/tabs/index.ts` — PR

#### `src/modules/tabs/lib/` — DONE (15 files)

- DONE `src/modules/tabs/lib/environmentMove.test.ts` — LOCAL-ONLY
- DONE `src/modules/tabs/lib/environmentMove.ts` — LOCAL-ONLY
- DONE `src/modules/tabs/lib/movePaneToNewTab.test.ts` — PR
- DONE `src/modules/tabs/lib/moveTabIntoSplit.test.ts` — PR
- DONE `src/modules/tabs/lib/newTabPosition.test.ts` — PR
- DONE `src/modules/tabs/lib/newTabPosition.ts` — PR
- DONE `src/modules/tabs/lib/planFileTabOpen.test.ts` — PR+LOCAL
- DONE `src/modules/tabs/lib/tabLabel.test.ts` — PR
- DONE `src/modules/tabs/lib/tabLabel.ts` — PR
- DONE `src/modules/tabs/lib/useTabSwitcher.test.ts` — PR
- DONE `src/modules/tabs/lib/useTabSwitcher.ts` — PR
- DONE `src/modules/tabs/lib/useTabs.ts` — PR+LOCAL
- DONE `src/modules/tabs/lib/useWindowTitle.ts` — PR
- DONE `src/modules/tabs/lib/useWorkspaceCwd.test.ts` — PR
- DONE `src/modules/tabs/lib/useWorkspaceCwd.ts` — PR

Inspection: all 37 paths received a non-frozen breadth pass. Production control flow was read; larger tests were inspected through fixtures, case names and assertions, not every line. AI/agent branches, language override and browser/Markdown preview responsibilities in shared files remained opaque and excluded. No frozen inventory file was opened. Existing scoped suite: 187 tests / 25 files passed; three added restore-grant cases failed before the correction and passed in the full suite afterward.

### 08 — Application startup, windows and quit

Status: **DONE**. Review time: 213 seconds (20:32:37–20:36:10 UTC), within five-minute cap; final ledger/checkpoint administration afterward. Source edits: 0. Findings: R019–R021.

#### `src/` — DONE (1 files)

- DONE `src/main.tsx` — PR+LOCAL

#### `src-tauri/src/` — DONE (1 files)

- DONE `src-tauri/src/main.rs` — PR

#### `src-tauri/src/modules/` — DONE (7 files)

- DONE `src-tauri/src/modules/panics.rs` — PR
- DONE `src-tauri/src/modules/profile.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/quick_terminal.rs` — PR
- DONE `src-tauri/src/modules/runtime.rs` — PR
- DONE `src-tauri/src/modules/second_launch.rs` — PR
- DONE `src-tauri/src/modules/window_presentation.rs` — PR
- DONE `src-tauri/src/modules/windows.rs` — PR+LOCAL

#### `src-tauri/src/modules/windows/` — DONE (2 files)

- DONE `src-tauri/src/modules/windows/quit.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/windows/restore.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/windows/restore/` — DONE (1 files)

- DONE `src-tauri/src/modules/windows/restore/tests.rs` — LOCAL-ONLY

#### `src/app/` — DONE (7 files)

- DONE `src/app/contentSecurityPolicy.test.ts` — PR
- DONE `src/app/dist-budget.test.ts` — PR
- DONE `src/app/eager-budget.test.ts` — PR
- DONE `src/app/licensing.test.ts` — PR
- DONE `src/app/os-integration.test.ts` — PR
- DONE `src/app/source-encoding.test.ts` — PR
- DONE `src/app/tauri-versions.test.ts` — PR

#### `src/app/components/` — DONE (4 files)

- DONE `src/app/components/CloseDialogs.test.ts` — PR
- DONE `src/app/components/CloseDialogs.tsx` — PR+LOCAL
- DONE `src/app/components/WorkspaceSurface.availability.test.tsx` — LOCAL-ONLY
- DONE `src/app/components/useSystemInfo.ts` — PR

#### `src/app/hooks/` — DONE (14 files)

- DONE `src/app/hooks/quitApproval.test.ts` — LOCAL-ONLY
- DONE `src/app/hooks/quitApproval.ts` — LOCAL-ONLY
- DONE `src/app/hooks/tabCloseGuards.test.ts` — LOCAL-ONLY
- DONE `src/app/hooks/tabCloseGuards.ts` — LOCAL-ONLY
- DONE `src/app/hooks/terminalRestart.test.ts` — PR
- DONE `src/app/hooks/terminalRestart.ts` — PR
- DONE `src/app/hooks/useAppCloseGuard.test.ts` — PR
- DONE `src/app/hooks/useAppCloseGuard.ts` — PR+LOCAL
- DONE `src/app/hooks/useCloseGuards.races.test.ts` — LOCAL-ONLY
- DONE `src/app/hooks/useOpenFolder.ts` — PR
- DONE `src/app/hooks/useTabCloseGuards.ts` — LOCAL-ONLY
- DONE `src/app/hooks/useTerminalRestart.ts` — PR
- DONE `src/app/hooks/useWorkspaceSwitcher.test.ts` — LOCAL-ONLY
- DONE `src/app/hooks/useWorkspaceSwitcher.ts` — PR+LOCAL

#### `src/components/` — DONE (1 files)

- DONE `src/components/WindowControls.tsx` — PR

#### `src/quick/` — DONE (3 files)

- DONE `src/quick/QuickTerminalApp.test.tsx` — PR
- DONE `src/quick/QuickTerminalApp.tsx` — PR
- DONE `src/quick/main.tsx` — PR

#### `src/settings/` — DONE (1 files)

- DONE `src/settings/main.tsx` — PR+LOCAL

Inspection: all 42 listed paths received one non-frozen breadth pass. Production control flow was read; larger test files were inspected through fixtures, case names and assertions rather than line by line. Build-budget/CSP tests containing frozen feature checks were treated as opaque at those checks; their referenced implementations were not opened. Shared startup/profile/window code was assessed only for non-frozen responsibilities, not AI persistence, credentials, theme snapshots or preview behavior. No section-08 source edits, new tests or architecture implementation. Existing full-suite checks passed on macOS; no Windows restoration or native quick-terminal reproduction is claimed. Section 09 remains unopened.

### 09 — Workspace authorization and environment

Status: **DONE**. Review time: 59 seconds (20:40:20–20:41:19 UTC), within five-minute cap. Source edits: 0. Findings: R022–R025.

#### `src-tauri/src/modules/` — DONE (2 files)

- DONE `src-tauri/src/modules/asset_scope.rs` — PR
- DONE `src-tauri/src/modules/workspace.rs` — PR+LOCAL

#### `src/modules/workspace/` — DONE (10 files)

- DONE `src/modules/workspace/allFolders.test.ts` — PR+LOCAL
- DONE `src/modules/workspace/allFolders.ts` — PR+LOCAL
- DONE `src/modules/workspace/authorize.test.ts` — PR
- DONE `src/modules/workspace/authorize.ts` — PR
- DONE `src/modules/workspace/availability.test.tsx` — LOCAL-ONLY
- DONE `src/modules/workspace/availability.ts` — LOCAL-ONLY
- DONE `src/modules/workspace/env.test.ts` — PR
- DONE `src/modules/workspace/env.ts` — PR
- DONE `src/modules/workspace/index.ts` — PR
- DONE `src/modules/workspace/owner.tsx` — LOCAL-ONLY

Inspection: 12 non-frozen paths received a breadth pass; larger native tests were sampled by cases and assertions. Shared app authorization/environment logic only; AI branches and preview asset behavior excluded. Three preview-only paths had been misclassified in this section: initial reads exposed the responsibility in asset_all_folders.rs and assetUrl.ts; inspection stopped and both plus the unopened assetUrl.test.ts were moved to F2. This is an inventory correction, not completed preview coverage. AssetScope was assessed only for grant bookkeeping; preview behavior was not investigated. No source changes or new tests.

### 10 — Filesystem operations and document saves

Status: **DONE**. Review time: 185 seconds (20:41:44–20:44:49 UTC), within five-minute cap; final ledger administration afterward. Source edits: 0. Findings: R026–R030.

#### `src-tauri/src/modules/fs/` — DONE (15 files)

- DONE `src-tauri/src/modules/fs/access_control.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/clipboard.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/copy.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/destination.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/document_save.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/file.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/file_identity.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/interactive.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/launch.rs` — PR
- DONE `src-tauri/src/modules/fs/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/mutate.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/mutation_events.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/private_staging.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/run_prompt.rs` — PR
- DONE `src-tauri/src/modules/fs/tree.rs` — PR+LOCAL

#### `src-tauri/src/modules/fs/access_control/` — DONE (3 files)

- DONE `src-tauri/src/modules/fs/access_control/extended.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/access_control/linux.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/fs/access_control/macos.rs` — LOCAL-ONLY

Inspection: 18 non-frozen paths received one breadth pass. Production control flow read; large embedded test suites inspected through case names, assertions and representative fixtures, not line by line. Shared AI/attachment helpers were treated as opaque; AI validation/provenance branches and preview mapping branches were excluded. secret_paths.rs was found to be dedicated AI/content-import policy during its initial read and moved to F1 without investigation or edits. Known Windows theme blocker K001 was not investigated; R026 records the independently visible editor-save impact. No product edits, new tests, architecture design or subsequent-section review.

### 11 — Filesystem watchers

Status: **DONE**. Review time: 43 seconds (20:46:18–20:47:01 UTC), within five-minute cap. Source edits: 0. Findings: R031–R034.

#### `src-tauri/src/modules/fs/` — DONE (1 files)

- DONE `src-tauri/src/modules/fs/watch.rs` — PR+LOCAL

#### `src-tauri/src/modules/fs/watch/` — DONE (3 files)

- DONE `src-tauri/src/modules/fs/watch/macos.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/watch/plan.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/fs/watch/portable.rs` — PR+LOCAL

Inspection: all four files received a breadth pass. Production paths read; large embedded suites sampled through case names, assertions and relevant fixtures. Platform-specific branches were inspected but Windows/Linux runtime behavior was not exercised. No product edit, new test or architecture proposal.

### 12 — Editor documents, recovery and diffs

Status: **DONE**. Review time: 204 seconds (20:47:47–20:51:11 UTC), within five-minute cap; final ledger/checkpoint administration afterward. Source edits: 0. Findings: R035–R040.

#### `src/modules/editor/` — DONE (9 files)

- DONE `src/modules/editor/EditorStack.tsx` — LOCAL-ONLY
- DONE `src/modules/editor/GitDiffPane.live.test.tsx` — LOCAL-ONLY
- DONE `src/modules/editor/GitDiffPane.tsx` — PR+LOCAL
- DONE `src/modules/editor/GitDiffStack.tsx` — LOCAL-ONLY
- DONE `src/modules/editor/NewEditorDialog.tsx` — PR
- DONE `src/modules/editor/SplitDiffView.tsx` — PR
- DONE `src/modules/editor/index.ts` — PR
- DONE `src/modules/editor/useDocumentMutations.ts` — LOCAL-ONLY
- DONE `src/modules/editor/useEditorFileSync.ts` — PR+LOCAL

#### `src/modules/editor/lib/` — DONE (41 files)

- DONE `src/modules/editor/lib/chromeTheme.ts` — PR
- DONE `src/modules/editor/lib/cmThemes.test.ts` — PR
- DONE `src/modules/editor/lib/cmThemes.ts` — PR
- DONE `src/modules/editor/lib/diffCache.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/diffCache.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/diffTheme.ts` — PR
- DONE `src/modules/editor/lib/discardBridge.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/discardBridge.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/discardCoordinator.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/discardCoordinator.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/documentMutations.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/documentMutations.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/fileWatchTargets.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/fileWatchTargets.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/gitGutter.test.ts` — PR
- DONE `src/modules/editor/lib/gitGutter.ts` — PR
- DONE `src/modules/editor/lib/gitSignals.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/gitSignals.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/indent.test.ts` — PR
- DONE `src/modules/editor/lib/indent.ts` — PR
- DONE `src/modules/editor/lib/liveDiff.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/liveDiff.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/markdownExtras.ts` — PR
- DONE `src/modules/editor/lib/nativeDiscard.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/pathRetarget.test.ts` — PR
- DONE `src/modules/editor/lib/pathRetarget.ts` — PR
- DONE `src/modules/editor/lib/quitBarrier.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/quitExtension.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/quitExtension.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/recoveryTarget.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/recoveryTarget.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/saveConflict.test.ts` — PR+LOCAL; deleted/missing in working copy
- DONE `src/modules/editor/lib/saveConflict.ts` — PR+LOCAL; deleted/missing in working copy
- DONE `src/modules/editor/lib/themes.ts` — PR
- DONE `src/modules/editor/lib/useDocument.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/useDocument.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/useDocument.workspace.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/viewSync.test.ts` — PR
- DONE `src/modules/editor/lib/viewSync.ts` — PR
- DONE `src/modules/editor/lib/watchWorkingDiff.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/watchWorkingDiff.ts` — LOCAL-ONLY

Inspection: all 50 listed paths received one breadth pass: production source, test case names and representative assertions, and the removed HEAD side of the two deleted save-conflict files. Large test suites were sampled, not exhaustively audited. Editor palettes/chrome were inspected as static styling only; theme persistence was not opened. Mixed editor files contain language, Markdown-preview and AI hooks: those branches/imports were treated as opaque, with no follow-through into frozen implementations. This DONE status covers the eligible responsibilities, not those frozen branches. The frozen DocumentSession implementation was not opened; calls into it were treated as opaque.

Validation: 107 existing tests passed across the 19 present section-12 test files. No new test or source change. No live cross-window/navigation reproduction, full-suite rerun or platform certification claimed. Speculative consequences requiring frozen document internals were not promoted to confirmed defects.

### 13 — Editor search and Vim dependencies

Status: **DONE**. Review time: 126 seconds (20:54:02–20:56:08 UTC), within five-minute cap. Source edits: 0. Findings: R041–R044.

#### `packages/codemirror-vim/` — DONE (15 files)

- DONE `packages/codemirror-vim/LICENSE` — LOCAL-ONLY
- DONE `packages/codemirror-vim/README.md` — LOCAL-ONLY
- DONE `packages/codemirror-vim/UPSTREAM.md` — LOCAL-ONLY
- DONE `packages/codemirror-vim/async-runtime.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/async-runtime.test.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/index.d.ts` — LOCAL-ONLY
- DONE `packages/codemirror-vim/package.json` — LOCAL-ONLY
- DONE `packages/codemirror-vim/regex-worker.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/regex-worker.test.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/result-budget.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/result-budget.test.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/scrolling.test.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/worker-budget.d.ts` — LOCAL-ONLY
- DONE `packages/codemirror-vim/worker-budget.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/worker.real.test.js` — LOCAL-ONLY

#### `packages/codemirror-vim-core/` — DONE (8 files)

- DONE `packages/codemirror-vim-core/LICENSE` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/README.md` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/UPSTREAM.md` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/main.d.ts` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/package.json` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/replacement.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/replacement.test.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim-core/resumable.js` — LOCAL-ONLY

#### `packages/codemirror-vim-core/upstream/` — DONE (1 files)

- DONE `packages/codemirror-vim-core/upstream/vim.js` — LOCAL-ONLY

#### `packages/codemirror-vim-core/upstream-tests/` — DONE (1 files)

- DONE `packages/codemirror-vim-core/upstream-tests/vim_test.js` — LOCAL-ONLY

#### `packages/codemirror-vim/upstream/` — DONE (1 files)

- DONE `packages/codemirror-vim/upstream/index.js` — LOCAL-ONLY

#### `scripts/editor-search/` — DONE (5 files)

- DONE `scripts/editor-search/README.md` — LOCAL-ONLY
- DONE `scripts/editor-search/index.html` — LOCAL-ONLY
- DONE `scripts/editor-search/probe.ts` — LOCAL-ONLY
- DONE `scripts/editor-search/vite.config.ts` — LOCAL-ONLY
- DONE `scripts/editor-search/worker-probe.mjs` — LOCAL-ONLY

#### `scripts/vim-review/` — DONE (10 files)

- DONE `scripts/vim-review/README.md` — LOCAL-ONLY
- DONE `scripts/vim-review/compare-corpus.mjs` — LOCAL-ONLY
- DONE `scripts/vim-review/index.html` — LOCAL-ONLY
- DONE `scripts/vim-review/lazyvim-probe.py` — LOCAL-ONLY
- DONE `scripts/vim-review/settle.d.ts` — LOCAL-ONLY
- DONE `scripts/vim-review/settle.js` — LOCAL-ONLY
- DONE `scripts/vim-review/terminal-bridge.ts` — LOCAL-ONLY
- DONE `scripts/vim-review/upstream-adapted.js` — LOCAL-ONLY
- DONE `scripts/vim-review/vite.config.ts` — LOCAL-ONLY
- DONE `scripts/vim-review/worker-probe.mjs` — LOCAL-ONLY

#### `src/modules/editor/lib/` — DONE (5 files)

- DONE `src/modules/editor/lib/editorKeymap.test.ts` — PR
- DONE `src/modules/editor/lib/editorKeymap.ts` — PR
- DONE `src/modules/editor/lib/searchCount.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/searchCount.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/searchPanel.ts` — PR+LOCAL

#### `src/modules/editor/search/` — DONE (9 files)

- DONE `src/modules/editor/search/regexClient.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexClient.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexEvaluation.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexState.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexTypes.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexView.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexView.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexWorker.real.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/search/regexWorker.ts` — LOCAL-ONLY

Inspection: all 55 inventory paths received a breadth pass. Read small production helpers, manifests, licenses and probe scripts; sampled the large bundled declarations, pristine upstream core/adapter and both 6,000-line test corpora through structure, command/search entry points and representative assertions. This is not a line-by-line audit of those upstream fixtures or proof of Vim parity. XML/filetype-specific branches and frozen maintained core/adapter integration files were not reviewed. References to frozen features in mixed documentation remain opaque. A truncated combined read was followed by bounded reads of the relevant sampled entry points; unseen content is not claimed as inspected.

Validation: 147 tests passed in 11 section test files, including real-worker timeout/recovery probes. Two small read-only helper probes confirmed R042's retained command slot and R043's binding ordering. No new tests, source edits, live WebView corpus run or LazyVim launch. No architecture proposal.

### 14 — Language servers

Status: **DONE**. Review time: 93 seconds (20:56:45–20:58:18 UTC), within five-minute cap; final ledger/checkpoint administration afterward. Source edits: 0. Findings: R045–R053.

#### `src-tauri/src/modules/lsp/` — DONE (5 files)

- DONE `src-tauri/src/modules/lsp/env.rs` — PR
- DONE `src-tauri/src/modules/lsp/framing.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/lsp/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/lsp/ownership.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/lsp/session.rs` — PR+LOCAL

#### `src/modules/lsp/components/` — DONE (1 files)

- DONE `src/modules/lsp/components/LspStatusPill.tsx` — PR+LOCAL

#### `src/modules/lsp/lib/` — DONE (22 files)

- DONE `src/modules/lsp/lib/client.format.test.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/client.ts` — PR+LOCAL
- DONE `src/modules/lsp/lib/detect.test.ts` — PR
- DONE `src/modules/lsp/lib/detect.ts` — PR
- DONE `src/modules/lsp/lib/locations.test.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/locations.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/navigation.test.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/orderedWriter.test.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/orderedWriter.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/presets.ts` — PR
- DONE `src/modules/lsp/lib/runtimeStore.test.ts` — PR
- DONE `src/modules/lsp/lib/runtimeStore.ts` — PR
- DONE `src/modules/lsp/lib/safeMarkdown.test.ts` — PR
- DONE `src/modules/lsp/lib/safeMarkdown.ts` — PR
- DONE `src/modules/lsp/lib/sessionManager.test.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/sessionManager.ts` — PR+LOCAL
- DONE `src/modules/lsp/lib/transport.test.ts` — PR+LOCAL
- DONE `src/modules/lsp/lib/transport.ts` — PR+LOCAL
- DONE `src/modules/lsp/lib/uri.test.ts` — PR+LOCAL
- DONE `src/modules/lsp/lib/uri.ts` — PR+LOCAL
- DONE `src/modules/lsp/lib/useLspHint.test.ts` — PR
- DONE `src/modules/lsp/lib/useLspHint.ts` — PR+LOCAL

#### `src/settings/components/` — DONE (1 files)

- DONE `src/settings/components/LspInstallDialog.tsx` — PR+LOCAL

Inspection: all 29 inventory paths received a breadth pass. Production admission, ownership, framing, process/writer lifecycle, session management, navigation, formatting, installation and URI paths read; large existing test suites sampled through case names and representative assertions/fixtures. Initial combined output truncated; affected production portions were reread in bounded chunks. No unseen output is claimed as reviewed. Shared page-token/preferences helpers, language-override calls and preview/AI references remained opaque; no dedicated frozen file was opened or edited. Adjacent unlisted LSP implementation files were not swept into this pass.

Validation: 78 existing frontend tests in 11 files and 49 native LSP tests passed. A read-only URI probe confirmed R048. No tests added, source changes, real language-server integration, Windows/Linux execution, new process policy or architecture proposal. These results do not certify incoming traffic bounds or platform cleanup.

### 15 — Git backend and isolated execution

Status: **DONE**. Review time: 193 seconds (21:02:48–21:06:01 UTC), within five-minute cap. Source edits: 0. Findings: R054–R059.

Breadth method: inspected worker packaging/bootstrap and native execution, ownership, publication, parsing, command and worktree paths; sampled larger test modules and ran the focused suites. Large modules received targeted production-path and regression sampling, not exhaustive line-by-line review. The AI command in `commands.rs` was skipped; `ai_diff.rs` was reclassified FROZEN by path without opening. Existing WSL mutation refusal in `DirectoryPin::acquire` is an explicit platform limitation, not a newly introduced fix. No signed-app/XPC execution or Windows/Linux certification performed.

Validation: 163 non-AI Git unit tests and 61 Git integration tests passed. No new tests or product changes.

#### `scripts/git-worker/` — DONE (3 files)

- DONE `scripts/git-worker/build.mjs` — LOCAL-ONLY
- DONE `scripts/git-worker/smoke.mjs` — LOCAL-ONLY
- DONE `scripts/git-worker/verify-app.mjs` — LOCAL-ONLY

#### `src-tauri/git-worker/` — DONE (11 files)

- DONE `src-tauri/git-worker/README.md` — LOCAL-ONLY
- DONE `src-tauri/git-worker/apple_git.h` — LOCAL-ONLY
- DONE `src-tauri/git-worker/apple_git.m` — LOCAL-ONLY
- DONE `src-tauri/git-worker/client.h` — LOCAL-ONLY
- DONE `src-tauri/git-worker/client.m` — LOCAL-ONLY
- DONE `src-tauri/git-worker/entitlements.plist` — LOCAL-ONLY
- DONE `src-tauri/git-worker/protocol.c` — LOCAL-ONLY
- DONE `src-tauri/git-worker/protocol.h` — LOCAL-ONLY
- DONE `src-tauri/git-worker/service.m` — LOCAL-ONLY
- DONE `src-tauri/git-worker/signature.h` — LOCAL-ONLY
- DONE `src-tauri/git-worker/smoke.m` — LOCAL-ONLY

#### `src-tauri/src/modules/git/` — DONE (16 files)

- DONE `src-tauri/src/modules/git/candidate_index.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/candidate_policy.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/commands.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/git/commit_files.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/discard.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/errors.rs` — PR
- DONE `src-tauri/src/modules/git/index_publication.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/git/operations.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/git/ownership.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/parser.rs` — PR
- DONE `src-tauri/src/modules/git/process.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/git/types.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/git/utils.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/git/worker.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/git/worktree.rs` — PR+LOCAL

#### `src-tauri/tests/` — DONE (1 files)

- DONE `src-tauri/tests/git_operations.rs` — PR+LOCAL

### 16 — Source control and Git history UI

Status: **DONE**. Review time: 95 seconds (21:06:45–21:08:20 UTC), within five-minute cap. Source edits: 0. Findings: R060–R065.

Breadth method: inspected history loading/paging/cache ownership, Undo, repository targeting, status refresh and mutations, worktree forms, tree rows and watcher lifecycle. Large components and tests received targeted non-AI production-path/test sampling, not exhaustive line-by-line review. AI commit-generation helpers, state, handlers and tests were excluded from investigation; shared native imports were opaque and not followed. An incidental AI-test tail appeared in a mixed-file range and was not investigated. Dedicated frozen paths were not opened or edited.

Validation: 117 tests passed in 12 explicitly selected non-AI test files. The mixed `useSourceControlPanel.races.test.ts` was sampled only for non-AI cases and was not run. No live UI race reproduction or full-suite certification claimed.

#### `src/modules/git-history/` — DONE (7 files)

- DONE `src/modules/git-history/GitHistoryPane.tsx` — PR+LOCAL
- DONE `src/modules/git-history/GitHistoryPane.workspace.test.tsx` — LOCAL-ONLY
- DONE `src/modules/git-history/GitHistoryStack.tsx` — LOCAL-ONLY
- DONE `src/modules/git-history/GitHistoryStack.workspace.test.tsx` — LOCAL-ONLY
- DONE `src/modules/git-history/RefChips.tsx` — PR
- DONE `src/modules/git-history/UndoCommitDialog.tsx` — PR+LOCAL
- DONE `src/modules/git-history/UndoCommitDialog.workspace.test.tsx` — LOCAL-ONLY

#### `src/modules/git-history/lib/` — DONE (4 files)

- DONE `src/modules/git-history/lib/historyPaging.test.ts` — PR
- DONE `src/modules/git-history/lib/historyPaging.ts` — PR
- DONE `src/modules/git-history/lib/refs.test.ts` — PR
- DONE `src/modules/git-history/lib/refs.ts` — PR

#### `src/modules/source-control/` — DONE (22 files)

- DONE `src/modules/source-control/NestedRepositories.tsx` — PR
- DONE `src/modules/source-control/SourceControlPanel.tsx` — PR+LOCAL
- DONE `src/modules/source-control/WorktreeDialogs.races.test.tsx` — LOCAL-ONLY
- DONE `src/modules/source-control/WorktreeDialogs.tsx` — PR+LOCAL
- DONE `src/modules/source-control/changeTree.test.ts` — PR
- DONE `src/modules/source-control/changeTree.ts` — PR
- DONE `src/modules/source-control/changeViewMode.ts` — PR
- DONE `src/modules/source-control/gitWatch.test.ts` — LOCAL-ONLY
- DONE `src/modules/source-control/gitWatch.ts` — PR+LOCAL
- DONE `src/modules/source-control/refreshSignals.test.ts` — PR
- DONE `src/modules/source-control/refreshSignals.ts` — PR
- DONE `src/modules/source-control/useRepositoryOwner.ts` — LOCAL-ONLY
- DONE `src/modules/source-control/useRepositoryTargeting.ts` — PR
- DONE `src/modules/source-control/useSourceControl.test.ts` — PR
- DONE `src/modules/source-control/useSourceControl.ts` — PR+LOCAL
- DONE `src/modules/source-control/useSourceControl.workspace.test.ts` — LOCAL-ONLY
- DONE `src/modules/source-control/useSourceControlContext.ts` — PR+LOCAL
- DONE `src/modules/source-control/useSourceControlPanel.races.test.ts` — LOCAL-ONLY
- DONE `src/modules/source-control/useSourceControlPanel.ts` — PR+LOCAL
- DONE `src/modules/source-control/worktreeCommands.ts` — PR+LOCAL
- DONE `src/modules/source-control/worktrees.test.ts` — PR
- DONE `src/modules/source-control/worktrees.ts` — PR

### 17 — Native PTY and shell integration

Status: **DONE**. Review time: 126 seconds (21:12:03–21:14:09 UTC), within five-minute cap. Source edits: 0. Findings: R066–R074.

Breadth method: inspected PTY command admission, spawn/close, output transport framing/scheduling, process capture/tree ownership, cwd/drop validation, environment setup, shell scripts and scrollback storage. Large native modules/test blocks received targeted production-path and regression sampling, not exhaustive line-by-line review. Shared process primitives were reviewed for ordinary native consumers; AI call sites and the dedicated agent detector were not opened or reviewed. Windows/WSL branches were source-only.

Validation: PTY suite initially reported 186 passed / 1 failed / 1 ignored; the single timing failure passed in an isolated retry (R074). Process helpers: 16 passed. Scrollback: 7 passed. Fish executable unavailable, so fish fixture was inspected but not executed. No production code or tests changed.

#### `src-tauri/src/modules/` — DONE (1 files)

- DONE `src-tauri/src/modules/terminal_scrollback.rs` — PR

#### `src-tauri/src/modules/proc/` — DONE (5 files)

- DONE `src-tauri/src/modules/proc/capture.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/proc/group.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/proc/job.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/proc/mod.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/proc/rss.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/pty/` — DONE (13 files)

- DONE `src-tauri/src/modules/pty/cwd.rs` — PR
- DONE `src-tauri/src/modules/pty/da_filter.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/pty/fish_legacy.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/pty/foreground.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/pty/gate.rs` — PR
- DONE `src-tauri/src/modules/pty/hub.rs` — PR
- DONE `src-tauri/src/modules/pty/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/pty/path_drop.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/pty/protocol.rs` — PR
- DONE `src-tauri/src/modules/pty/session.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/pty/shell_init.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/pty/terminal_env.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/pty/wire.rs` — PR

#### `src-tauri/src/modules/pty/path_drop/` — DONE (2 files)

- DONE `src-tauri/src/modules/pty/path_drop/wsl.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/pty/path_drop/wsl_probe.sh` — LOCAL-ONLY

#### `src-tauri/src/modules/pty/scripts/` — DONE (10 files)

- DONE `src-tauri/src/modules/pty/scripts/bashrc.bash` — PR
- DONE `src-tauri/src/modules/pty/scripts/init.fish` — PR+LOCAL
- DONE `src-tauri/src/modules/pty/scripts/init.legacy.fish` — LOCAL-ONLY
- DONE `src-tauri/src/modules/pty/scripts/init.test.fish` — PR
- DONE `src-tauri/src/modules/pty/scripts/profile.cmd` — PR
- DONE `src-tauri/src/modules/pty/scripts/profile.ps1` — PR
- DONE `src-tauri/src/modules/pty/scripts/zlogin.zsh` — PR
- DONE `src-tauri/src/modules/pty/scripts/zprofile.zsh` — PR
- DONE `src-tauri/src/modules/pty/scripts/zshenv.zsh` — PR
- DONE `src-tauri/src/modules/pty/scripts/zshrc.zsh` — PR

### 18 — Terminal sessions and transport

Status: **DONE**. Review time: 92 seconds (21:16:18–21:17:50 UTC), within the five-minute cap. Source edits: 0. Findings: R075–R078.

Breadth method: all 49 paths inspected, with symbol/test inventories and representative implementation/assertion sampling for large session, integration, transport, pane-transform and scrollback files. Inspected startup/restart/disposal, receive/ack flow, input backpressure, restore/save gates, pane layout, status, presentation and quick-hotkey consumers. This is a sampled coverage pass, not a line-by-line audit. AI/preview exports and imported frozen implementations were treated as opaque and not followed; theme persistence and language/XML code were not reviewed. Dedicated input/rendering/model implementations remain for their later sections.

Validation: all 148 tests in the section's 17 test files passed. Log: `/tmp/oarlock-section18-tests.log`. No source changes or new tests; no live-terminal restart race, persistence-failure injection, or cross-platform UI validation claimed.

#### `src/modules/terminal/` — DONE (5 files)

- DONE `src/modules/terminal/PaneTreeView.tsx` — PR
- DONE `src/modules/terminal/TerminalPane.tsx` — PR
- DONE `src/modules/terminal/TerminalPromptDialog.tsx` — PR
- DONE `src/modules/terminal/TerminalStack.tsx` — PR+LOCAL
- DONE `src/modules/terminal/index.ts` — PR+LOCAL

#### `src/modules/terminal/ghostty/` — DONE (5 files)

- DONE `src/modules/terminal/ghostty/resizePromptRedraw.test.ts` — PR
- DONE `src/modules/terminal/ghostty/terminalIntegration.test.ts` — PR
- DONE `src/modules/terminal/ghostty/terminalIntegration.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/windowPresentation.ts` — PR

#### `src/modules/terminal/ghostty/core/` — DONE (4 files)

- DONE `src/modules/terminal/ghostty/core/GhosttySemanticEventRouter.test.ts` — PR
- DONE `src/modules/terminal/ghostty/core/GhosttySemanticEventRouter.ts` — PR
- DONE `src/modules/terminal/ghostty/core/PromptPresentationGate.ts` — PR
- DONE `src/modules/terminal/ghostty/core/ResizePromptHold.ts` — PR

#### `src/modules/terminal/lib/` — DONE (33 files)

- DONE `src/modules/terminal/lib/BoundedPtyWriter.test.ts` — PR
- DONE `src/modules/terminal/lib/BoundedPtyWriter.ts` — PR
- DONE `src/modules/terminal/lib/PtyOutputHub.ts` — PR
- DONE `src/modules/terminal/lib/PtyOutputReceiver.ts` — PR
- DONE `src/modules/terminal/lib/paneLayout.test.ts` — PR
- DONE `src/modules/terminal/lib/paneLayout.ts` — PR
- DONE `src/modules/terminal/lib/panes.test.ts` — PR
- DONE `src/modules/terminal/lib/panes.transforms.test.ts` — PR
- DONE `src/modules/terminal/lib/panes.ts` — PR
- DONE `src/modules/terminal/lib/pty-bridge.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/pty-bridge.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/ptyPresentation.ts` — PR
- DONE `src/modules/terminal/lib/ptyWire.ts` — PR
- DONE `src/modules/terminal/lib/terminalAreaMoved.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalAreaMoved.ts` — PR
- DONE `src/modules/terminal/lib/terminalCwdReports.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalCwdReports.ts` — PR
- DONE `src/modules/terminal/lib/terminalDiagnostics.ts` — PR
- DONE `src/modules/terminal/lib/terminalDiagnosticsEnabled.ts` — PR
- DONE `src/modules/terminal/lib/terminalPrompts.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalPrompts.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalResizeInteraction.ts` — PR
- DONE `src/modules/terminal/lib/terminalScrollback.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalScrollback.ts` — PR
- DONE `src/modules/terminal/lib/terminalScrollbackRestore.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalScrollbackRestore.ts` — PR
- DONE `src/modules/terminal/lib/terminalSessionApi.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalSessionApi.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalStatus.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalStatus.ts` — PR
- DONE `src/modules/terminal/lib/terminalSurfaceTarget.ts` — PR
- DONE `src/modules/terminal/lib/windowProgress.test.ts` — PR
- DONE `src/modules/terminal/lib/windowProgress.ts` — PR

#### `src/modules/terminal/quick/` — DONE (2 files)

- DONE `src/modules/terminal/quick/quickTerminalHotkey.test.ts` — PR
- DONE `src/modules/terminal/quick/quickTerminalHotkey.ts` — PR

### 19 — Terminal input, links, clipboard and drops

Status: **DONE**. Review time: 77 seconds (21:20:11–21:21:28 UTC), within the five-minute cap. Source edits: 0. Findings: R079–R083.

Breadth method: 47 eligible paths, including two removed files inspected from the PR base. Large input/controller and native clipboard files sampled by entry points, cancellation/admission paths, platform branches and representative tests; this is not exhaustive line-by-line review. `clipboard_snapshot.rs` revealed an AI-only entry point during symbol inventory: implementation review stopped and the path moved to F1. Preview hooks remained opaque; no dedicated preview implementation opened. Native page ownership imports were not followed into frozen networking code.

Validation: 247 frontend tests in 20 files and 17 native tests passed (read 5, write 4, image 4, primary 4). Linux GTK/Wayland tests were inspected only and are platform-gated/ignored here; Windows shell coverage is not claimed. Logs: `/tmp/oarlock-section19-tests.log`, `/tmp/oarlock-section19-native-{read,write,image,primary}.log`. No new tests or fixes.

#### `src-tauri/capabilities/` — DONE (1 files)

- DONE `src-tauri/capabilities/clipboard.json` — PR+LOCAL

#### `src-tauri/src/modules/` — DONE (4 files)

- DONE `src-tauri/src/modules/clipboard_image.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/clipboard_read.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/clipboard_write.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/primary_selection.rs` — PR+LOCAL

#### `src-tauri/src/modules/clipboard_read/` — DONE (3 files)

- DONE `src-tauri/src/modules/clipboard_read/focus.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/clipboard_read/linux.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/clipboard_read/linux_tests.rs` — LOCAL-ONLY

#### `src/lib/` — DONE (2 files)

- DONE `src/lib/clipboardWrite.test.ts` — LOCAL-ONLY
- DONE `src/lib/clipboardWrite.ts` — LOCAL-ONLY

#### `src/modules/terminal/ghostty/` — DONE (1 files)

- DONE `src/modules/terminal/ghostty/terminalIntegration.clipboard.test.ts` — PR+LOCAL

#### `src/modules/terminal/ghostty/core/` — DONE (2 files)

- DONE `src/modules/terminal/ghostty/core/terminalLinks.test.ts` — PR
- DONE `src/modules/terminal/ghostty/core/terminalLinks.ts` — PR

#### `src/modules/terminal/ghostty/input/` — DONE (4 files)

- DONE `src/modules/terminal/ghostty/input/GhosttyInputController.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/input/GhosttyInputController.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/input/terminalInputEncoding.test.ts` — PR
- DONE `src/modules/terminal/ghostty/input/terminalInputEncoding.ts` — PR

#### `src/modules/terminal/lib/` — DONE (30 files)

- DONE `src/modules/terminal/lib/LatestClipboardWrite.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/LatestClipboardWrite.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/TerminalRequestLifetime.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/TerminalRequestLifetime.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/fileDropLifetime.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/keymap.test.ts` — PR
- DONE `src/modules/terminal/lib/keymap.ts` — PR
- DONE `src/modules/terminal/lib/osc-handlers.test.ts` — PR
- DONE `src/modules/terminal/lib/osc-handlers.ts` — PR
- DONE `src/modules/terminal/lib/programDrop.test.ts` — PR
- DONE `src/modules/terminal/lib/programDrop.ts` — PR
- DONE `src/modules/terminal/lib/quoteShellPath.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/quoteShellPath.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/quoteShellPath.windows.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/shellDropInsertion.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/shellDropInsertion.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/shellPathDrop.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/shellPathDrop.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/terminalClipboard.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalClipboard.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalClipboardSnapshot.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/terminalClipboardSnapshot.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/lib/terminalLinkOpen.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalLinkOpen.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalLinkTargets.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalLinkTargets.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/terminalLinks.test.ts` — PR; deleted/missing in working copy
- DONE `src/modules/terminal/lib/terminalLinks.ts` — PR; deleted/missing in working copy
- DONE `src/modules/terminal/lib/useTerminalFileDrop.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/lib/useTerminalFileDrop.ts` — PR+LOCAL

### 20 — Terminal blocks, search and selection

Status: **DONE**. Review time: 84 seconds (21:22:20–21:23:44 UTC), within the five-minute cap. Source edits: 0. Findings: R084–R088; AP002 awaits decision.

Breadth method: all 29 listed paths inspected through production entry points, representative implementation ranges, test cases/assertions and the focused suite. Large editor, block, selection and search sources were sampled, not exhaustively read. Imported AI/history providers, frozen language/preview/theme persistence implementations were not followed; the shell editor's AI shortcut text was treated as an opaque label. Regex workers, limits, lifecycle, selection pointer ownership, shell completion and history UI were covered. No section beyond 20 opened.

Validation: 121 tests in 13 files passed, including the production-worker catastrophic-backtracking/recovery probe and Bash compatibility test. A separate read-only Bun probe called production `pathCompletions` with a mocked native entry named `$(printf oarlock_completion_probe)`, observed its raw label with no custom apply handler, and passed that label as an unquoted argument to `/bin/sh`: stdout was `oarlock_completion_probe`, exit 0, rather than the literal filename. No file creation, destructive command, full mounted autocomplete interaction or remote test was involved. This establishes shell interpretation of the emitted completion; AP002 holds the fix. Test log: `/tmp/oarlock-section20-tests.log`. No source edits or new persistent tests.

#### `src/modules/terminal/backend/` — DONE (2 files)

- DONE `src/modules/terminal/backend/selection.test.ts` — PR
- DONE `src/modules/terminal/backend/selection.ts` — PR

#### `src/modules/terminal/block/` — DONE (1 files)

- DONE `src/modules/terminal/block/ShellInput.tsx` — PR+LOCAL

#### `src/modules/terminal/block/lib/` — DONE (7 files)

- DONE `src/modules/terminal/block/lib/completionKeys.test.ts` — PR
- DONE `src/modules/terminal/block/lib/completionKeys.ts` — PR
- DONE `src/modules/terminal/block/lib/historyPopover.test.ts` — PR
- DONE `src/modules/terminal/block/lib/historyPopover.ts` — PR
- DONE `src/modules/terminal/block/lib/pathComplete.test.ts` — PR
- DONE `src/modules/terminal/block/lib/pathComplete.ts` — PR
- DONE `src/modules/terminal/block/lib/shellEditor.ts` — PR

#### `src/modules/terminal/ghostty/` — DONE (4 files)

- DONE `src/modules/terminal/ghostty/GhosttyBlocks.test.ts` — PR
- DONE `src/modules/terminal/ghostty/GhosttyBlocks.ts` — PR
- DONE `src/modules/terminal/ghostty/ghosttyBlockSessions.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/shellBlockCompatibility.test.ts` — PR

#### `src/modules/terminal/ghostty/search/` — DONE (12 files)

- DONE `src/modules/terminal/ghostty/search/GhosttySearchController.test.ts` — PR
- DONE `src/modules/terminal/ghostty/search/GhosttySearchController.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/search/RegexTerminalSearch.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/search/RegexTerminalSearch.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/search/regexController.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexEvaluation.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexLifetime.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexProtocol.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexWorker.real.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexWorker.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexWorkerClient.test.ts` — LOCAL-ONLY
- DONE `src/modules/terminal/ghostty/search/regexWorkerClient.ts` — LOCAL-ONLY

#### `src/modules/terminal/ghostty/selection/` — DONE (2 files)

- DONE `src/modules/terminal/ghostty/selection/TerminalSelectionController.test.ts` — PR
- DONE `src/modules/terminal/ghostty/selection/TerminalSelectionController.ts` — PR

#### `src/modules/terminal/search/` — DONE (1 files)

- DONE `src/modules/terminal/search/TerminalSearchController.ts` — PR

### 21 — Terminal WebGPU rendering

Status: **DONE**. Review time: 166 seconds (21:28:24–21:31:10 UTC), within the five-minute cap. Source edits: 0. Findings: R089–R090.

Breadth method: inspected all 23 listed paths through symbol inventories and representative implementation/assertion ranges. Sampled runtime scheduling/recovery, surface borrowed-memory uploads and cleanup, shared-canvas ownership/layout, uniform/shader geometry, image cache/conversion, animation, fit, ligatures and links. Generated Nerd Font constraints were checked by provenance/header and decoding/accessor structure, not regenerated or exhaustively audited. Large files were sampled, not certified line by line. Appearance-token imports remained opaque; no frozen storage or other frozen code was opened.

Validation: all 211 tests in nine section-local test files passed (`/tmp/oarlock-section21-tests.log`). GPU harness tests do not certify real driver/WebKit rendering or device-loss behavior. No large-allocation reproduction, source changes or new persistent tests.

#### `src/modules/terminal/ghostty/gpu/` — DONE (23 files)

- DONE `src/modules/terminal/ghostty/gpu/GcPressure.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/ScreenUniform.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/ScreenUniform.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/TerminalFit.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/TerminalFit.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/WebGpuImageLayer.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/WebGpuTerminalRuntime.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/WebGpuTerminalRuntime.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/WebGpuTerminalSurface.test.ts` — PR+LOCAL
- DONE `src/modules/terminal/ghostty/gpu/WebGpuTerminalSurface.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/WebGpuWindowCanvas.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/WebGpuWindowCanvas.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/imageAnimation.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/imageAnimation.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/imageLayer.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/imageLayer.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/ligatureRuns.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/ligatureRuns.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/linkUnderline.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/linkUnderline.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/nerdFontConstraints.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/shaders.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/terminalVisuals.ts` — PR

### 22 — Terminal WebGL rendering

Status: **DONE**. Review time: 98 seconds (21:31:10–21:32:48 UTC), within the five-minute cap. Source edits: 0. Findings: R091–R094.

Breadth method: inspected all 12 listed paths, including upstream provenance, symbol/test-case inventories and representative implementation/assertion ranges. Sampled renderer pooling/pacing, context failure and restoration, borrowed cell/image uploads, surface visibility/resize/cleanup, shader compilation/framebuffer lifecycle and resource allocation. Large renderer/test files were sampled, not exhaustively audited. Imports into other sections and frozen implementations remained opaque.

Validation: all 58 tests in six section-local test files passed (`/tmp/oarlock-section22-tests.log`). These use fake/recording GPU contexts; real GPU allocation failures, context restoration and chunk-load failures were not reproduced. No source changes or new persistent tests.

#### `src/modules/terminal/ghostty/webgl/` — DONE (12 files)

- DONE `src/modules/terminal/ghostty/webgl/UPSTREAM.md` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlImageLayer.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlOverlays.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlPresentation.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlTerminalRuntime.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlTerminalRuntime.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlTerminalSurface.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlTerminalSurface.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/customShader.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/customShader.ts` — PR

### 23 — Ghostty model and WASM package

Status: **DONE**. Review time: 94 seconds (21:34:15–21:35:49 UTC), within the five-minute cap. Source edits: 0. Findings: R095–R096.

Breadth method: all 30 paths sampled through provenance/package declarations, symbol and test inventories, representative bridge/model lifecycle and ABI ranges, event/reply handling and assertions. The 4,679-line Zig bridge and large TypeScript wrappers/tests were sampled, not exhaustively audited. Both binary headers, sizes and SHA-256 hashes match the recorded SIMD/scalar artifacts. Benchmark and stack-probe setup were inspected; no benchmark or rebuild claimed.

Validation: 355 tests passed in ten section-local files, including real WASM protocol, loader, GPU/SoA equivalence, lifecycle and stack tests. Log: `/tmp/oarlock-section23-tests.log`. Source-level failure cases below were not separately reproduced. No source edits or new persistent tests.

#### `packages/ghostty-core/` — DONE (2 files)

- DONE `packages/ghostty-core/FORK.md` — PR
- DONE `packages/ghostty-core/package.json` — PR

#### `packages/ghostty-core/adapted/` — DONE (3 files)

- DONE `packages/ghostty-core/adapted/UPSTREAM.md` — PR
- DONE `packages/ghostty-core/adapted/ghostty-vt-scalar.wasm` — PR
- DONE `packages/ghostty-core/adapted/ghostty-vt.wasm` — PR

#### `packages/ghostty-core/adapted/wasm/` — DONE (1 files)

- DONE `packages/ghostty-core/adapted/wasm/build.zig` — PR

#### `packages/ghostty-core/adapted/wasm/src/` — DONE (1 files)

- DONE `packages/ghostty-core/adapted/wasm/src/oarlock.zig` — PR

#### `packages/ghostty-core/lib/` — DONE (2 files)

- DONE `packages/ghostty-core/lib/protocol.ts` — PR
- DONE `packages/ghostty-core/lib/types.ts` — PR

#### `packages/ghostty-core/lib/adapted/` — DONE (4 files)

- DONE `packages/ghostty-core/lib/adapted/OarlockGhostty.ts` — PR
- DONE `packages/ghostty-core/lib/adapted/gpuCells.ts` — PR
- DONE `packages/ghostty-core/lib/adapted/index.ts` — PR
- DONE `packages/ghostty-core/lib/adapted/types.ts` — PR

#### `packages/ghostty-core/lib/official/` — DONE (1 files)

- DONE `packages/ghostty-core/lib/official/callbackBridge.ts` — PR

#### `packages/ghostty-core/official/` — DONE (1 files)

- DONE `packages/ghostty-core/official/UPSTREAM.md` — PR

#### `src/modules/terminal/ghostty/` — DONE (15 files)

- DONE `src/modules/terminal/ghostty/AdaptedGhostty.bench.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedGhostty.test.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedGhosttyGpu.test.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedGhosttyGpuModel.test.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedGhosttyModelProtocols.test.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedGhosttyProtocols.test.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedGhosttyTerminalModel.ts` — PR
- DONE `src/modules/terminal/ghostty/AdaptedLoader.test.ts` — PR
- DONE `src/modules/terminal/ghostty/GhosttyCoreRuntime.test.ts` — PR
- DONE `src/modules/terminal/ghostty/GhosttyCoreRuntime.ts` — PR
- DONE `src/modules/terminal/ghostty/GhosttyTerminalModel.ts` — PR
- DONE `src/modules/terminal/ghostty/GhosttyWasmStack.test.ts` — PR
- DONE `src/modules/terminal/ghostty/OfficialGhostty.test.ts` — PR
- DONE `src/modules/terminal/ghostty/coreCompatibility.test.ts` — PR
- DONE `src/modules/terminal/ghostty/wasmStackProbe.ts` — PR

### 24 — Fonts, glyphs and typography

Status: **DONE**. Review time: 104 seconds (21:35:49–21:37:33 UTC), within the five-minute cap. Source edits: 0. Findings: R097–R100.

Breadth method: all 72 paths sampled via source/test inventories and representative implementations/assertions: font acquisition/feature lifetimes, native font lookup, atlas allocation/reset/disposal, glyph budgeting/rasterization/constraints, procedural sprite geometry, generation tooling, CSS and license provenance. All 24 WOFF2 assets have valid magic and header lengths matching their file sizes; binary glyph outlines were not visually certified or regenerated. Generated CSS tests check referenced assets, ranges and size budgets. Large geometry tables and tests were sampled, not exhaustively audited.

Validation: 374 frontend tests passed in 18 section-local files; two native `modules::system_fonts::tests` passed. Logs: `/tmp/oarlock-section24-tests.log` and `/tmp/oarlock-section24-native-tests.log`. No installed-font/UI race, memory-pressure, interrupted rebuild or real-GPU reproduction claimed. No source changes or new persistent tests.

#### `packages/ghostty-core/lib/adapted/` — DONE (1 files)

- DONE `packages/ghostty-core/lib/adapted/gpuGlyphs.ts` — PR

#### `scripts/jetbrains-mono/` — DONE (2 files)

- DONE `scripts/jetbrains-mono/build.test.ts` — PR
- DONE `scripts/jetbrains-mono/build.ts` — PR

#### `scripts/lib/` — DONE (1 files)

- DONE `scripts/lib/fonts.ts` — PR

#### `scripts/nerd-font-constraints/` — DONE (2 files)

- DONE `scripts/nerd-font-constraints/build.test.ts` — PR
- DONE `scripts/nerd-font-constraints/build.ts` — PR

#### `scripts/symbols-font/` — DONE (3 files)

- DONE `scripts/symbols-font/build.test.ts` — PR
- DONE `scripts/symbols-font/build.ts` — PR
- DONE `scripts/symbols-font/wawoff2.d.ts` — PR

#### `src-tauri/src/modules/` — DONE (1 files)

- DONE `src-tauri/src/modules/system_fonts.rs` — PR

#### `src/assets/fonts/jetbrains-mono/` — DONE (13 files)

- DONE `src/assets/fonts/jetbrains-mono/OFL.txt` — PR
- DONE `src/assets/fonts/jetbrains-mono/italic-box.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/italic-greek-cyrillic.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/italic-latin-ext.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/italic-latin.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/italic-other.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/italic-symbols.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/normal-box.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/normal-greek-cyrillic.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/normal-latin-ext.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/normal-latin.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/normal-other.woff2` — PR
- DONE `src/assets/fonts/jetbrains-mono/normal-symbols.woff2` — PR

#### `src/assets/fonts/symbols/` — DONE (13 files)

- DONE `src/assets/fonts/symbols/NOTICE.txt` — PR
- DONE `src/assets/fonts/symbols/codicons.woff2` — PR
- DONE `src/assets/fonts/symbols/devicons.woff2` — PR
- DONE `src/assets/fonts/symbols/font-awesome-extension.woff2` — PR
- DONE `src/assets/fonts/symbols/font-awesome.woff2` — PR
- DONE `src/assets/fonts/symbols/font-logos.woff2` — PR
- DONE `src/assets/fonts/symbols/material-design-1.woff2` — PR
- DONE `src/assets/fonts/symbols/material-design-2.woff2` — PR
- DONE `src/assets/fonts/symbols/material-design-3.woff2` — PR
- DONE `src/assets/fonts/symbols/octicons.woff2` — PR
- DONE `src/assets/fonts/symbols/powerline.woff2` — PR
- DONE `src/assets/fonts/symbols/seti.woff2` — PR
- DONE `src/assets/fonts/symbols/weather.woff2` — PR

#### `src/lib/` — DONE (2 files)

- DONE `src/lib/fonts.test.ts` — PR
- DONE `src/lib/fonts.ts` — PR

#### `src/modules/terminal/ghostty/gpu/` — DONE (18 files)

- DONE `src/modules/terminal/ghostty/gpu/BuiltinGlyphs.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/BuiltinGlyphs.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphAtlas.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphAtlas.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphFontGate.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphFontGate.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphMap.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphMap.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphMapModel.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphRasterizer.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/GlyphRasterizer.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/glyphColor.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/glyphColor.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/glyphConstraint.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/glyphConstraint.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/minimumContrast.test.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/minimumContrast.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/textContrast.ts` — PR

#### `src/modules/terminal/ghostty/gpu/builtin/` — DONE (5 files)

- DONE `src/modules/terminal/ghostty/gpu/builtin/SpriteMask.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/builtin/boxDrawing.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/builtin/branch.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/builtin/legacyComputing.ts` — PR
- DONE `src/modules/terminal/ghostty/gpu/builtin/legacyComputingSupplement.ts` — PR

#### `src/modules/terminal/ghostty/webgl/` — DONE (2 files)

- DONE `src/modules/terminal/ghostty/webgl/WebGlGlyphAtlas.test.ts` — PR
- DONE `src/modules/terminal/ghostty/webgl/WebGlGlyphAtlas.ts` — PR

#### `src/modules/terminal/lib/` — DONE (4 files)

- DONE `src/modules/terminal/lib/fontFeatures.test.ts` — PR
- DONE `src/modules/terminal/lib/fontFeatures.ts` — PR
- DONE `src/modules/terminal/lib/terminalFontOffsets.test.ts` — PR
- DONE `src/modules/terminal/lib/terminalFontOffsets.ts` — PR

#### `src/styles/` — DONE (5 files)

- DONE `src/styles/fonts.css` — PR
- DONE `src/styles/jetbrains-mono.css` — PR
- DONE `src/styles/jetbrains-mono.test.ts` — PR
- DONE `src/styles/symbols.css` — PR
- DONE `src/styles/symbols.test.ts` — PR

### 25 — Non-storage appearance, theme formats and styling

Status: **DONE**. Review time: 83 seconds (21:41:35–21:42:58 UTC), within the five-minute cap. Source edits: 0. Findings: R101–R105.

Breadth method: all 62 paths sampled through representative source and test assertions, theme data/fixture headers and palette entries, parser boundaries, background-image ownership, native backdrop/portal handling and CSS sections. Bundled palette equivalence and fixture conversion exercised by existing tests. Large files were sampled; no visual/platform certification. Assigned imports into other sections remained opaque; no DONE section reopened.

Validation: 130 frontend tests in 15 section-local files passed (`/tmp/oarlock-section25-tests.log`). Native backdrop tests launched separately; final result recorded at checkpoint. Linux portal behavior was source-reviewed only on macOS. No new reproductions, source changes or persistent tests.

#### `src-tauri/src/modules/` — DONE (2 files)

- DONE `src-tauri/src/modules/color_scheme.rs` — PR
- DONE `src-tauri/src/modules/vibrancy.rs` — PR

#### `src/modules/theme/` — DONE (10 files)

- DONE `src/modules/theme/SurfaceLayer.tsx` — PR
- DONE `src/modules/theme/WindowVibrancyBridge.tsx` — PR
- DONE `src/modules/theme/applyTheme.test.ts` — PR
- DONE `src/modules/theme/applyTheme.ts` — PR
- DONE `src/modules/theme/bgImageStore.ts` — PR
- DONE `src/modules/theme/terminalTranslucency.ts` — PR
- DONE `src/modules/theme/types.ts` — PR
- DONE `src/modules/theme/vibrancy.test.ts` — PR
- DONE `src/modules/theme/vibrancy.ts` — PR
- DONE `src/modules/theme/vibrancyQueue.test.ts` — PR

#### `src/modules/theme/schemes/` — DONE (17 files)

- DONE `src/modules/theme/schemes/alacritty.test.ts` — PR
- DONE `src/modules/theme/schemes/alacritty.ts` — PR
- DONE `src/modules/theme/schemes/color.test.ts` — PR
- DONE `src/modules/theme/schemes/color.ts` — PR
- DONE `src/modules/theme/schemes/ghostty.test.ts` — PR
- DONE `src/modules/theme/schemes/ghostty.ts` — PR
- DONE `src/modules/theme/schemes/importTheme.test.ts` — PR
- DONE `src/modules/theme/schemes/importTheme.ts` — PR
- DONE `src/modules/theme/schemes/iterm.test.ts` — PR
- DONE `src/modules/theme/schemes/iterm.ts` — PR
- DONE `src/modules/theme/schemes/minimalToml.ts` — PR
- DONE `src/modules/theme/schemes/minimalYaml.ts` — PR
- DONE `src/modules/theme/schemes/plist.ts` — PR
- DONE `src/modules/theme/schemes/scheme.test.ts` — PR
- DONE `src/modules/theme/schemes/scheme.ts` — PR
- DONE `src/modules/theme/schemes/windowsTerminal.test.ts` — PR
- DONE `src/modules/theme/schemes/windowsTerminal.ts` — PR

#### `src/modules/theme/schemes/__fixtures__/` — DONE (4 files)

- DONE `src/modules/theme/schemes/__fixtures__/NOTICE.txt` — PR
- DONE `src/modules/theme/schemes/__fixtures__/OneHalfDark.itermcolors` — PR
- DONE `src/modules/theme/schemes/__fixtures__/flexoki-dark.json` — PR
- DONE `src/modules/theme/schemes/__fixtures__/flexoki-dark.toml` — PR

#### `src/modules/theme/schemes/__fixtures__/ghostty/` — DONE (13 files)

- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Ayu` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Ayu Light` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Ayu Mirage` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Flexoki Dark` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Flexoki Light` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/GitHub Dark Default` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/GitHub Light Default` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Light Owl` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Night Owl` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/One Half Dark` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/One Half Light` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Tomorrow` — PR
- DONE `src/modules/theme/schemes/__fixtures__/ghostty/Tomorrow Night` — PR

#### `src/modules/theme/themes/` — DONE (11 files)

- DONE `src/modules/theme/themes/NOTICE.txt` — PR
- DONE `src/modules/theme/themes/ayu-mirage.ts` — PR
- DONE `src/modules/theme/themes/ayu.ts` — PR
- DONE `src/modules/theme/themes/bundled.test.ts` — PR
- DONE `src/modules/theme/themes/flexoki.ts` — PR
- DONE `src/modules/theme/themes/github.ts` — PR
- DONE `src/modules/theme/themes/index.ts` — PR
- DONE `src/modules/theme/themes/night-owl.ts` — PR
- DONE `src/modules/theme/themes/oarlock-default.ts` — PR
- DONE `src/modules/theme/themes/one-half.ts` — PR
- DONE `src/modules/theme/themes/tomorrow.ts` — PR

#### `src/styles/` — DONE (5 files)

- DONE `src/styles/backgroundSurface.test.ts` — PR
- DONE `src/styles/compositingBudget.test.ts` — PR
- DONE `src/styles/globals.css` — PR
- DONE `src/styles/motionBudget.test.ts` — PR
- DONE `src/styles/windowChrome.test.ts` — PR

### 26 — Ordinary settings and shared UI utilities

Status: **DONE**. Review time: 162 seconds (21:42:58–21:45:40 UTC), within the five-minute cap and previous longest section. Source edits: 0. Findings: R106–R110.

Inspection: one sampled breadth pass over all 57 paths: native persistence/history entry points, settings parsing and setters, component async lifetimes, shared utility implementations and representative test assertions. Imports into other sections treated as opaque. Large files were sampled, not reviewed line by line; truncated output was not counted as read. No live GUI, history-resource stress, concurrent settings or platform metadata reproduction. Validation: 116 frontend tests in 26 files and 16 native tests (8 preferences, 8 history), all passed. No source change or new test.

#### `src-tauri/src/modules/` — DONE (2 files)

- DONE `src-tauri/src/modules/base64.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/preferences.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/history/` — DONE (1 files)

- DONE `src-tauri/src/modules/history/mod.rs` — PR

#### `src/lib/` — DONE (22 files)

- DONE `src/lib/appWindow.test.ts` — PR
- DONE `src/lib/appWindow.ts` — PR
- DONE `src/lib/external-link.ts` — PR
- DONE `src/lib/ime.test.ts` — PR
- DONE `src/lib/ime.ts` — PR
- DONE `src/lib/launchDir.test.ts` — PR
- DONE `src/lib/launchDir.ts` — PR
- DONE `src/lib/matchCount.test.ts` — PR+LOCAL
- DONE `src/lib/matchCount.ts` — PR+LOCAL
- DONE `src/lib/nativeContextMenu.test.ts` — PR
- DONE `src/lib/nativeContextMenu.ts` — PR
- DONE `src/lib/nativeDropPoint.test.ts` — PR
- DONE `src/lib/nativeDropPoint.ts` — PR
- DONE `src/lib/pathKey.test.ts` — PR
- DONE `src/lib/pathKey.ts` — PR
- DONE `src/lib/platform.test.ts` — PR
- DONE `src/lib/shellQuote.test.ts` — PR
- DONE `src/lib/shellQuote.ts` — PR
- DONE `src/lib/treeKeyMove.test.ts` — PR
- DONE `src/lib/treeKeyMove.ts` — PR
- DONE `src/lib/windowFrame.test.ts` — PR
- DONE `src/lib/windowFrame.ts` — PR

#### `src/modules/header/` — DONE (2 files)

- DONE `src/modules/header/Header.tsx` — PR
- DONE `src/modules/header/SearchInline.tsx` — PR+LOCAL

#### `src/modules/settings/` — DONE (19 files)

- DONE `src/modules/settings/allFolders.test.ts` — PR+LOCAL
- DONE `src/modules/settings/diffViewMode.test.ts` — PR
- DONE `src/modules/settings/editorDefaultIndent.test.ts` — PR
- DONE `src/modules/settings/nativePreferences.test.ts` — LOCAL-ONLY
- DONE `src/modules/settings/nativePreferences.ts` — LOCAL-ONLY
- DONE `src/modules/settings/openSettingsWindow.ts` — PR
- DONE `src/modules/settings/prefGuards.test.ts` — PR
- DONE `src/modules/settings/preferences.test.ts` — LOCAL-ONLY
- DONE `src/modules/settings/preferences.ts` — PR+LOCAL
- DONE `src/modules/settings/readiness.test.ts` — LOCAL-ONLY
- DONE `src/modules/settings/readiness.ts` — LOCAL-ONLY
- DONE `src/modules/settings/sidebarPosition.test.ts` — PR
- DONE `src/modules/settings/store.ts` — PR+LOCAL
- DONE `src/modules/settings/terminalBehavior.test.ts` — PR
- DONE `src/modules/settings/terminalBehavior.ts` — PR
- DONE `src/modules/settings/terminalLigatures.test.ts` — PR
- DONE `src/modules/settings/terminalLineHeight.test.ts` — PR
- DONE `src/modules/settings/terminalOpacity.test.ts` — PR
- DONE `src/modules/settings/windowVibrancyDefault.test.ts` — LOCAL-ONLY

#### `src/modules/statusbar/` — DONE (2 files)

- DONE `src/modules/statusbar/CwdBreadcrumb.tsx` — PR
- DONE `src/modules/statusbar/DiagnosticsBadge.tsx` — PR

#### `src/modules/statusbar/lib/` — DONE (2 files)

- DONE `src/modules/statusbar/lib/pathUtils.test.ts` — PR
- DONE `src/modules/statusbar/lib/pathUtils.ts` — PR

#### `src/settings/sections/` — DONE (7 files)

- DONE `src/settings/sections/AboutSection.tsx` — PR
- DONE `src/settings/sections/EditorSection.tsx` — PR+LOCAL
- DONE `src/settings/sections/FolderAccessSettings.tsx` — PR
- DONE `src/settings/sections/GeneralSection.tsx` — PR
- DONE `src/settings/sections/TerminalBehaviorSettings.tsx` — PR
- DONE `src/settings/sections/aboutLinks.test.ts` — PR
- DONE `src/settings/sections/aboutLinks.ts` — PR

### 27 — Build, dependencies, CI and distribution

Status: **DONE**. Review time: 63 seconds (21:48:25–21:49:28 UTC), within the five-minute cap. Source edits: 0. Findings: R111–R114.

Inspection: sampled all 37 paths, including workflow/configuration behavior, dependency declarations, lockfile headers/workspace entries and removed pnpm/SignPath files from the PR base. Generated lockfiles were not audited dependency by dependency. JSON/plist parsing and offline locked Cargo metadata passed; Nix hash payload check found zero bytes for all three SHA-256 hashes. No release, install, network audit, CI run or signed package build performed. No source edits or new tests.

#### `./` — DONE (14 files)

- DONE `.coderabbit.yaml` — PR
- DONE `.gitignore` — PR
- DONE `.size-limit.json` — PR+LOCAL
- DONE `bun.lock` — PR+LOCAL
- DONE `bunfig.toml` — PR
- DONE `flake.nix` — PR
- DONE `index.html` — PR
- DONE `knip.json` — PR
- DONE `package.json` — PR+LOCAL
- DONE `pnpm-lock.yaml` — PR; deleted/missing in working copy
- DONE `pnpm-workspace.yaml` — PR; deleted/missing in working copy
- DONE `quick.html` — PR
- DONE `settings.html` — PR
- DONE `vite.config.ts` — PR

#### `.github/` — DONE (2 files)

- DONE `.github/CODEOWNERS` — PR
- DONE `.github/dependabot.yml` — PR

#### `.github/ISSUE_TEMPLATE/` — DONE (3 files)

- DONE `.github/ISSUE_TEMPLATE/bug_report.yml` — PR
- DONE `.github/ISSUE_TEMPLATE/config.yml` — PR
- DONE `.github/ISSUE_TEMPLATE/feature_request.yml` — PR

#### `.github/workflows/` — DONE (4 files)

- DONE `.github/workflows/ci.yml` — PR+LOCAL
- DONE `.github/workflows/release.yml` — PR+LOCAL
- DONE `.github/workflows/signpath-test.yml` — PR; deleted/missing in working copy
- DONE `.github/workflows/update-nix-sources.yml` — PR

#### `nix/` — DONE (2 files)

- DONE `nix/package.nix` — PR
- DONE `nix/sources.json` — PR

#### `src/` — DONE (1 files)

- DONE `src/vite-env.d.ts` — PR

#### `src-tauri/` — DONE (7 files)

- DONE `src-tauri/Cargo.lock` — PR+LOCAL
- DONE `src-tauri/Cargo.toml` — PR+LOCAL
- DONE `src-tauri/Info.plist` — PR
- DONE `src-tauri/build.rs` — PR+LOCAL
- DONE `src-tauri/installer-hooks.nsh` — PR
- DONE `src-tauri/tauri.conf.json` — PR+LOCAL
- DONE `src-tauri/tauri.windows.conf.json` — PR

#### `src-tauri/capabilities/` — DONE (3 files)

- DONE `src-tauri/capabilities/default.json` — PR
- DONE `src-tauri/capabilities/desktop.json` — PR
- DONE `src-tauri/capabilities/dialog.json` — PR

#### `src-tauri/linux/` — DONE (1 files)

- DONE `src-tauri/linux/oarlock.desktop` — PR

### 28 — Diagnostics and review/test tooling

Status: **DONE**. Review time: 173 seconds (21:50:05–21:52:58 UTC), within the five-minute cap and previous 213-second maximum. Source edits: fs-churn.mjs once; new fs-churn.test.ts twice (creation and formatting). Findings: R115–R120.

Inspection: sampled all 80 original paths, including source entry points, lifecycle/error handling, representative report calculations/test assertions, harness HTML/Swift/configuration and deleted Python implementations from the PR base. Large report/workload files were sampled, not exhaustively audited. Added and reviewed one regression test. Imports into DONE sections remained opaque; no GUI stress run, native bench-feature build, cross-platform execution or historical baseline export performed. Truncated output was not counted; missing middle samples were read separately.

#### `scripts/` — DONE (9 files)

- DONE `scripts/cross-clippy.sh` — PR
- DONE `scripts/dist-graph.mjs` — PR
- DONE `scripts/eager-graph.mjs` — PR
- DONE `scripts/eager-graph.test.ts` — PR
- DONE `scripts/ghostty-profile.mjs` — PR
- DONE `scripts/ghostty-profile.ts` — PR
- DONE `scripts/ghostty-soak.ts` — PR
- DONE `scripts/ghostty-webkit-memory.mjs` — PR
- DONE `scripts/tsconfig.json` — PR+LOCAL

#### `scripts/app-lab/` — DONE (10 files)

- DONE `scripts/app-lab/agent-sim.mjs` — PR
- DONE `scripts/app-lab/app_report.py` — PR; deleted/missing in working copy
- DONE `scripts/app-lab/app_report.test.ts` — PR
- DONE `scripts/app-lab/app_report.ts` — PR
- DONE `scripts/app-lab/export-tree.sh` — PR
- DONE `scripts/app-lab/fs-churn.mjs` — PR+LOCAL
- DONE `scripts/app-lab/fs-churn.test.ts` — LOCAL-ONLY; added in checkpoint 16
- DONE `scripts/app-lab/run.py` — PR; deleted/missing in working copy
- DONE `scripts/app-lab/run.test.ts` — PR
- DONE `scripts/app-lab/run.ts` — PR

#### `scripts/app-lab/experiments/` — DONE (1 files)

- DONE `scripts/app-lab/experiments/tab-switch-toggles.patch` — PR

#### `scripts/ghostty-webkit-memory/` — DONE (2 files)

- DONE `scripts/ghostty-webkit-memory/entry.ts` — PR
- DONE `scripts/ghostty-webkit-memory/host.swift` — PR

#### `scripts/ipc-profile/` — DONE (4 files)

- DONE `scripts/ipc-profile/run.py` — PR; deleted/missing in working copy
- DONE `scripts/ipc-profile/run.ts` — PR
- DONE `scripts/ipc-profile/smoke.ts` — PR
- DONE `scripts/ipc-profile/vite.config.ts` — PR

#### `scripts/lib/` — DONE (11 files)

- DONE `scripts/lib/buildCli.test.ts` — LOCAL-ONLY
- DONE `scripts/lib/bun-ffi.d.ts` — PR
- DONE `scripts/lib/cli.test.ts` — PR
- DONE `scripts/lib/cli.ts` — PR
- DONE `scripts/lib/errors.ts` — PR
- DONE `scripts/lib/format.test.ts` — PR
- DONE `scripts/lib/format.ts` — PR
- DONE `scripts/lib/gitWorkerSigning.test.js` — LOCAL-ONLY
- DONE `scripts/lib/http.ts` — PR
- DONE `scripts/lib/process.test.ts` — PR
- DONE `scripts/lib/process.ts` — PR

#### `scripts/pty-smoke/` — DONE (4 files)

- DONE `scripts/pty-smoke/driver-new.ts` — PR
- DONE `scripts/pty-smoke/run.py` — PR; deleted/missing in working copy
- DONE `scripts/pty-smoke/run.ts` — PR
- DONE `scripts/pty-smoke/vite.config.ts` — PR

#### `scripts/renderer-profile/` — DONE (15 files)

- DONE `scripts/renderer-profile/Lab.swift` — PR
- DONE `scripts/renderer-profile/lab.ts` — PR
- DONE `scripts/renderer-profile/lab_report.py` — PR; deleted/missing in working copy
- DONE `scripts/renderer-profile/lab_report.test.ts` — PR
- DONE `scripts/renderer-profile/lab_report.ts` — PR
- DONE `scripts/renderer-profile/libproc.ts` — PR
- DONE `scripts/renderer-profile/procstats.py` — PR; deleted/missing in working copy
- DONE `scripts/renderer-profile/procstats.test.ts` — PR
- DONE `scripts/renderer-profile/procstats.ts` — PR
- DONE `scripts/renderer-profile/run.py` — PR; deleted/missing in working copy
- DONE `scripts/renderer-profile/run.test.ts` — PR
- DONE `scripts/renderer-profile/run.ts` — PR
- DONE `scripts/renderer-profile/suite.sh` — PR
- DONE `scripts/renderer-profile/vite.config.ts` — PR
- DONE `scripts/renderer-profile/workloads.ts` — PR

#### `scripts/search-review/` — DONE (2 files)

- DONE `scripts/search-review/editor-regex-probe.mjs` — LOCAL-ONLY
- DONE `scripts/search-review/vim-regex-probe.mjs` — LOCAL-ONLY

#### `scripts/terminal-search/` — DONE (4 files)

- DONE `scripts/terminal-search/host.swift` — LOCAL-ONLY
- DONE `scripts/terminal-search/index.html` — LOCAL-ONLY
- DONE `scripts/terminal-search/probe.ts` — LOCAL-ONLY
- DONE `scripts/terminal-search/vite.config.ts` — LOCAL-ONLY

#### `scripts/terminal-shell-drop/` — DONE (3 files)

- DONE `scripts/terminal-shell-drop/probe.py` — LOCAL-ONLY
- DONE `scripts/terminal-shell-drop/regex-probe.mjs` — LOCAL-ONLY
- DONE `scripts/terminal-shell-drop/regex-worker-probe.mjs` — LOCAL-ONLY

#### `scripts/terminal-visual/` — DONE (6 files)

- DONE `scripts/terminal-visual/compare.mjs` — PR
- DONE `scripts/terminal-visual/grid.html` — PR
- DONE `scripts/terminal-visual/index.html` — PR
- DONE `scripts/terminal-visual/main.ts` — PR
- DONE `scripts/terminal-visual/spritePattern.ts` — PR
- DONE `scripts/terminal-visual/vite.config.ts` — PR

#### `src-tauri/src/modules/` — DONE (1 files)

- DONE `src-tauri/src/modules/bench.rs` — PR

#### `src-tauri/tests/common/` — DONE (1 files)

- DONE `src-tauri/tests/common/mod.rs` — PR+LOCAL

#### `src/bench/` — DONE (8 files)

- DONE `src/bench/BenchBridge.tsx` — PR
- DONE `src/bench/driver.ts` — PR
- DONE `src/bench/early.ts` — PR
- DONE `src/bench/flags.ts` — PR
- DONE `src/bench/gpuCounters.ts` — PR
- DONE `src/bench/smoothHooks.ts` — PR
- DONE `src/bench/smoothProbe.ts` — PR
- DONE `src/bench/types.ts` — PR

### 29 — Documentation and project policies

Status: **DONE**. Review time: 70 seconds (22:00:13–22:01:23 UTC), within the five-minute cap. Source edits: 0. Findings: R121–R125.

Inspection: one sampled breadth pass across all 37 documents, including headings and representative text from deleted translations/TERAX.md at the PR base. Checked current build/run guidance, security claims, architecture summaries and relative-link existence. Large guides were sampled, not audited line by line; no external links fetched or implementation sections reopened. Relative-link scan found zero missing targets. README explicitly defers Nix availability until the first release; R111 is a release-preparation gate rather than a claim that Nix is already advertised as available. No source change or new test.

#### `./` — DONE (9 files)

- DONE `CLAUDE.md` — PR
- DONE `CODE_OF_CONDUCT.md` — PR
- DONE `CONTRIBUTING.md` — PR
- DONE `NOTICE` — PR
- DONE `README.md` — PR+LOCAL
- DONE `ROADMAP.md` — PR
- DONE `SECURITY.md` — PR
- DONE `TERAX.md` — PR; deleted/missing in working copy
- DONE `TRIAGE.md` — PR

#### `.github/` — DONE (1 files)

- DONE `.github/PULL_REQUEST_TEMPLATE.md` — PR

#### `docs/` — DONE (1 files)

- DONE `docs/README.md` — PR

#### `docs/architecture/` — DONE (11 files)

- DONE `docs/architecture/app-lab.md` — PR
- DONE `docs/architecture/cli-control.md` — PR+LOCAL
- DONE `docs/architecture/ghostty-release-readiness.md` — PR
- DONE `docs/architecture/ghostty-resource-efficiency.md` — PR
- DONE `docs/architecture/ghostty-webgl-renderer.md` — PR
- DONE `docs/architecture/pty-shell-integration.md` — PR
- DONE `docs/architecture/pty-transport-v2.md` — PR
- DONE `docs/architecture/security-model.md` — PR+LOCAL
- DONE `docs/architecture/terminal-renderer-pool.md` — PR
- DONE `docs/architecture/terminal-renderer-v2.md` — PR
- DONE `docs/architecture/two-process-model.md` — PR

#### `docs/contributing/` — DONE (1 files)

- DONE `docs/contributing/testing.md` — PR

#### `docs/readme/` — DONE (11 files)

- DONE `docs/readme/README.de.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.es.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.fr.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.hi.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.id.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.ja.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.ko.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.pl.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.pt-BR.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.ru.md` — PR; deleted/missing in working copy
- DONE `docs/readme/README.zh-CN.md` — PR; deleted/missing in working copy

#### `scripts/search-review/` — DONE (1 files)

- DONE `scripts/search-review/README.md` — LOCAL-ONLY

#### `scripts/terminal-search/` — DONE (1 files)

- DONE `scripts/terminal-search/README.md` — LOCAL-ONLY

#### `scripts/terminal-visual/` — DONE (1 files)

- DONE `scripts/terminal-visual/README.md` — PR

### 30 — Branding and image assets

Status: **DONE**. Review time: 134 seconds (22:02:14–22:04:28 UTC), within the five-minute cap and previous 213-second maximum. Source edits: 0. Findings: R126–R129.

Inspection: all 213 paths received format-appropriate breadth inspection. Decoded all 157 PNGs (including deleted terax-icon.png from the PR base), two ICNS and three ICO files, checked dimensions/alpha and inspected four contact sheets. Parsed 37 SVGs/two XMLs and the JSON/web manifest; checked SVG external references and executable elements. Read branding guidance, tokens, geometry and sampled all three generators and the supplied font license. Rendered and viewed all eight PDF pages as a contact sheet using the PDF skill. The 157-entry asset manifest exactly matches files/bytes/hashes and lists every other file under branding. No legal/provenance certification, all-resolution visual guarantee, native installer/mobile validation or rebuild with external fonts/Sharp was attempted. New brand kit and current application icons differ as the documented pending integration handoff; no assumption that the kit must replace them in this PR. No source or asset change, no new test.

#### `./` — DONE (3 files)

- DONE `oarlock-icon.png` — PR
- DONE `oarlock-icon.svg` — PR
- DONE `terax-icon.png` — PR; deleted/missing in working copy

#### `branding/` — DONE (4 files)

- DONE `branding/README.md` — LOCAL-ONLY
- DONE `branding/asset-manifest.json` — LOCAL-ONLY
- DONE `branding/brand-overview.png` — LOCAL-ONLY
- DONE `branding/brand-overview.svg` — LOCAL-ONLY

#### `branding/app/` — DONE (21 files)

- DONE `branding/app/android-background.png` — LOCAL-ONLY
- DONE `branding/app/android-background.svg` — LOCAL-ONLY
- DONE `branding/app/android-foreground.png` — LOCAL-ONLY
- DONE `branding/app/android-foreground.svg` — LOCAL-ONLY
- DONE `branding/app/android-monochrome.png` — LOCAL-ONLY
- DONE `branding/app/android-monochrome.svg` — LOCAL-ONLY
- DONE `branding/app/icon-1024.png` — LOCAL-ONLY
- DONE `branding/app/icon-128.png` — LOCAL-ONLY
- DONE `branding/app/icon-16.png` — LOCAL-ONLY
- DONE `branding/app/icon-24.png` — LOCAL-ONLY
- DONE `branding/app/icon-256.png` — LOCAL-ONLY
- DONE `branding/app/icon-32.png` — LOCAL-ONLY
- DONE `branding/app/icon-48.png` — LOCAL-ONLY
- DONE `branding/app/icon-512.png` — LOCAL-ONLY
- DONE `branding/app/icon-64.png` — LOCAL-ONLY
- DONE `branding/app/icon-full-bleed-1024.png` — LOCAL-ONLY
- DONE `branding/app/icon-full-bleed.svg` — LOCAL-ONLY
- DONE `branding/app/icon-light.png` — LOCAL-ONLY
- DONE `branding/app/icon-light.svg` — LOCAL-ONLY
- DONE `branding/app/icon-manifest.json` — LOCAL-ONLY
- DONE `branding/app/icon.svg` — LOCAL-ONLY

#### `branding/app/platforms/` — DONE (17 files)

- DONE `branding/app/platforms/128x128.png` — LOCAL-ONLY
- DONE `branding/app/platforms/128x128@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/32x32.png` — LOCAL-ONLY
- DONE `branding/app/platforms/64x64.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square107x107Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square142x142Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square150x150Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square284x284Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square30x30Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square310x310Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square44x44Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square71x71Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/Square89x89Logo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/StoreLogo.png` — LOCAL-ONLY
- DONE `branding/app/platforms/icon.icns` — LOCAL-ONLY
- DONE `branding/app/platforms/icon.ico` — LOCAL-ONLY
- DONE `branding/app/platforms/icon.png` — LOCAL-ONLY

#### `branding/app/platforms/android/mipmap-anydpi-v26/` — DONE (1 files)

- DONE `branding/app/platforms/android/mipmap-anydpi-v26/ic_launcher.xml` — LOCAL-ONLY

#### `branding/app/platforms/android/mipmap-hdpi/` — DONE (5 files)

- DONE `branding/app/platforms/android/mipmap-hdpi/ic_launcher.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-hdpi/ic_launcher_background.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-hdpi/ic_launcher_foreground.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-hdpi/ic_launcher_monochrome.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-hdpi/ic_launcher_round.png` — LOCAL-ONLY

#### `branding/app/platforms/android/mipmap-mdpi/` — DONE (5 files)

- DONE `branding/app/platforms/android/mipmap-mdpi/ic_launcher.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-mdpi/ic_launcher_background.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-mdpi/ic_launcher_foreground.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-mdpi/ic_launcher_monochrome.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-mdpi/ic_launcher_round.png` — LOCAL-ONLY

#### `branding/app/platforms/android/mipmap-xhdpi/` — DONE (5 files)

- DONE `branding/app/platforms/android/mipmap-xhdpi/ic_launcher.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xhdpi/ic_launcher_background.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xhdpi/ic_launcher_foreground.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xhdpi/ic_launcher_monochrome.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xhdpi/ic_launcher_round.png` — LOCAL-ONLY

#### `branding/app/platforms/android/mipmap-xxhdpi/` — DONE (5 files)

- DONE `branding/app/platforms/android/mipmap-xxhdpi/ic_launcher.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxhdpi/ic_launcher_background.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxhdpi/ic_launcher_foreground.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxhdpi/ic_launcher_monochrome.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxhdpi/ic_launcher_round.png` — LOCAL-ONLY

#### `branding/app/platforms/android/mipmap-xxxhdpi/` — DONE (5 files)

- DONE `branding/app/platforms/android/mipmap-xxxhdpi/ic_launcher.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxxhdpi/ic_launcher_background.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxxhdpi/ic_launcher_foreground.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxxhdpi/ic_launcher_monochrome.png` — LOCAL-ONLY
- DONE `branding/app/platforms/android/mipmap-xxxhdpi/ic_launcher_round.png` — LOCAL-ONLY

#### `branding/app/platforms/ios/` — DONE (18 files)

- DONE `branding/app/platforms/ios/AppIcon-20x20@1x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-20x20@2x-1.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-20x20@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-20x20@3x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-29x29@1x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-29x29@2x-1.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-29x29@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-29x29@3x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-40x40@1x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-40x40@2x-1.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-40x40@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-40x40@3x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-512@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-60x60@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-60x60@3x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-76x76@1x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-76x76@2x.png` — LOCAL-ONLY
- DONE `branding/app/platforms/ios/AppIcon-83.5x83.5@2x.png` — LOCAL-ONLY

#### `branding/guide/` — DONE (1 files)

- DONE `branding/guide/Oarlock-Brand-Guide.pdf` — LOCAL-ONLY

#### `branding/guide/pages/` — DONE (16 files)

- DONE `branding/guide/pages/01.png` — LOCAL-ONLY
- DONE `branding/guide/pages/01.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/02.png` — LOCAL-ONLY
- DONE `branding/guide/pages/02.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/03.png` — LOCAL-ONLY
- DONE `branding/guide/pages/03.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/04.png` — LOCAL-ONLY
- DONE `branding/guide/pages/04.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/05.png` — LOCAL-ONLY
- DONE `branding/guide/pages/05.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/06.png` — LOCAL-ONLY
- DONE `branding/guide/pages/06.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/07.png` — LOCAL-ONLY
- DONE `branding/guide/pages/07.svg` — LOCAL-ONLY
- DONE `branding/guide/pages/08.png` — LOCAL-ONLY
- DONE `branding/guide/pages/08.svg` — LOCAL-ONLY

#### `branding/logo/` — DONE (32 files)

- DONE `branding/logo/horizontal-black.png` — LOCAL-ONLY
- DONE `branding/logo/horizontal-black.svg` — LOCAL-ONLY
- DONE `branding/logo/horizontal-navy.png` — LOCAL-ONLY
- DONE `branding/logo/horizontal-navy.svg` — LOCAL-ONLY
- DONE `branding/logo/horizontal-silver.png` — LOCAL-ONLY
- DONE `branding/logo/horizontal-silver.svg` — LOCAL-ONLY
- DONE `branding/logo/horizontal-white.png` — LOCAL-ONLY
- DONE `branding/logo/horizontal-white.svg` — LOCAL-ONLY
- DONE `branding/logo/mark-black.png` — LOCAL-ONLY
- DONE `branding/logo/mark-black.svg` — LOCAL-ONLY
- DONE `branding/logo/mark-navy.png` — LOCAL-ONLY
- DONE `branding/logo/mark-navy.svg` — LOCAL-ONLY
- DONE `branding/logo/mark-silver.png` — LOCAL-ONLY
- DONE `branding/logo/mark-silver.svg` — LOCAL-ONLY
- DONE `branding/logo/mark-white.png` — LOCAL-ONLY
- DONE `branding/logo/mark-white.svg` — LOCAL-ONLY
- DONE `branding/logo/stacked-black.png` — LOCAL-ONLY
- DONE `branding/logo/stacked-black.svg` — LOCAL-ONLY
- DONE `branding/logo/stacked-navy.png` — LOCAL-ONLY
- DONE `branding/logo/stacked-navy.svg` — LOCAL-ONLY
- DONE `branding/logo/stacked-silver.png` — LOCAL-ONLY
- DONE `branding/logo/stacked-silver.svg` — LOCAL-ONLY
- DONE `branding/logo/stacked-white.png` — LOCAL-ONLY
- DONE `branding/logo/stacked-white.svg` — LOCAL-ONLY
- DONE `branding/logo/wordmark-black.png` — LOCAL-ONLY
- DONE `branding/logo/wordmark-black.svg` — LOCAL-ONLY
- DONE `branding/logo/wordmark-navy.png` — LOCAL-ONLY
- DONE `branding/logo/wordmark-navy.svg` — LOCAL-ONLY
- DONE `branding/logo/wordmark-silver.png` — LOCAL-ONLY
- DONE `branding/logo/wordmark-silver.svg` — LOCAL-ONLY
- DONE `branding/logo/wordmark-white.png` — LOCAL-ONLY
- DONE `branding/logo/wordmark-white.svg` — LOCAL-ONLY

#### `branding/reference/` — DONE (1 files)

- DONE `branding/reference/approved-4B.png` — LOCAL-ONLY

#### `branding/social/` — DONE (4 files)

- DONE `branding/social/repository-card.png` — LOCAL-ONLY
- DONE `branding/social/repository-card.svg` — LOCAL-ONLY
- DONE `branding/social/social-card.png` — LOCAL-ONLY
- DONE `branding/social/social-card.svg` — LOCAL-ONLY

#### `branding/source/` — DONE (7 files)

- DONE `branding/source/Satoshi-license.txt` — LOCAL-ONLY
- DONE `branding/source/build-guide.py` — LOCAL-ONLY
- DONE `branding/source/build.mjs` — LOCAL-ONLY
- DONE `branding/source/finalize-icons.mjs` — LOCAL-ONLY
- DONE `branding/source/geometry.json` — LOCAL-ONLY
- DONE `branding/source/mark.svg` — LOCAL-ONLY
- DONE `branding/source/wordmark.svg` — LOCAL-ONLY

#### `branding/tokens/` — DONE (2 files)

- DONE `branding/tokens/brand.css` — LOCAL-ONLY
- DONE `branding/tokens/colors.json` — LOCAL-ONLY

#### `branding/web/` — DONE (9 files)

- DONE `branding/web/apple-touch-icon.png` — LOCAL-ONLY
- DONE `branding/web/favicon-16.png` — LOCAL-ONLY
- DONE `branding/web/favicon-32.png` — LOCAL-ONLY
- DONE `branding/web/favicon-48.png` — LOCAL-ONLY
- DONE `branding/web/favicon.ico` — LOCAL-ONLY
- DONE `branding/web/favicon.svg` — LOCAL-ONLY
- DONE `branding/web/icon-192.png` — LOCAL-ONLY
- DONE `branding/web/icon-512.png` — LOCAL-ONLY
- DONE `branding/web/site.webmanifest` — LOCAL-ONLY

#### `public/` — DONE (1 files)

- DONE `public/logo.png` — PR

#### `src-tauri/icons/` — DONE (17 files)

- DONE `src-tauri/icons/128x128.png` — PR
- DONE `src-tauri/icons/128x128@2x.png` — PR
- DONE `src-tauri/icons/32x32.png` — PR
- DONE `src-tauri/icons/64x64.png` — PR
- DONE `src-tauri/icons/Square107x107Logo.png` — PR
- DONE `src-tauri/icons/Square142x142Logo.png` — PR
- DONE `src-tauri/icons/Square150x150Logo.png` — PR
- DONE `src-tauri/icons/Square284x284Logo.png` — PR
- DONE `src-tauri/icons/Square30x30Logo.png` — PR
- DONE `src-tauri/icons/Square310x310Logo.png` — PR
- DONE `src-tauri/icons/Square44x44Logo.png` — PR
- DONE `src-tauri/icons/Square71x71Logo.png` — PR
- DONE `src-tauri/icons/Square89x89Logo.png` — PR
- DONE `src-tauri/icons/StoreLogo.png` — PR
- DONE `src-tauri/icons/icon.icns` — PR
- DONE `src-tauri/icons/icon.ico` — PR
- DONE `src-tauri/icons/icon.png` — PR

#### `src-tauri/icons/android/mipmap-hdpi/` — DONE (3 files)

- DONE `src-tauri/icons/android/mipmap-hdpi/ic_launcher.png` — PR
- DONE `src-tauri/icons/android/mipmap-hdpi/ic_launcher_foreground.png` — PR
- DONE `src-tauri/icons/android/mipmap-hdpi/ic_launcher_round.png` — PR

#### `src-tauri/icons/android/mipmap-mdpi/` — DONE (3 files)

- DONE `src-tauri/icons/android/mipmap-mdpi/ic_launcher.png` — PR
- DONE `src-tauri/icons/android/mipmap-mdpi/ic_launcher_foreground.png` — PR
- DONE `src-tauri/icons/android/mipmap-mdpi/ic_launcher_round.png` — PR

#### `src-tauri/icons/android/mipmap-xhdpi/` — DONE (3 files)

- DONE `src-tauri/icons/android/mipmap-xhdpi/ic_launcher.png` — PR
- DONE `src-tauri/icons/android/mipmap-xhdpi/ic_launcher_foreground.png` — PR
- DONE `src-tauri/icons/android/mipmap-xhdpi/ic_launcher_round.png` — PR

#### `src-tauri/icons/android/mipmap-xxhdpi/` — DONE (3 files)

- DONE `src-tauri/icons/android/mipmap-xxhdpi/ic_launcher.png` — PR
- DONE `src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_foreground.png` — PR
- DONE `src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_round.png` — PR

#### `src-tauri/icons/android/mipmap-xxxhdpi/` — DONE (3 files)

- DONE `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png` — PR
- DONE `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_foreground.png` — PR
- DONE `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_round.png` — PR

#### `src-tauri/icons/android/values/` — DONE (1 files)

- DONE `src-tauri/icons/android/values/ic_launcher_background.xml` — PR

#### `src-tauri/icons/ios/` — DONE (18 files)

- DONE `src-tauri/icons/ios/AppIcon-20x20@1x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-20x20@2x-1.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-20x20@2x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-20x20@3x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-29x29@1x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-29x29@2x-1.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-29x29@2x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-29x29@3x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-40x40@1x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-40x40@2x-1.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-40x40@2x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-40x40@3x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-512@2x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-60x60@2x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-60x60@3x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-76x76@1x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-76x76@2x.png` — PR
- DONE `src-tauri/icons/ios/AppIcon-83.5x83.5@2x.png` — PR

### F1 — AI, agents, MCP, skills and supporting request/credential code

Status: **DONE (437/437 files reviewed)**. Review times: 202 s (18), 209 s (19), 196 s (20), 194 s (21), 469 s (22), 310 s (23). Final continuation read autocomplete, MCP runtime/forms/settings and skills. Large-file/test sampling as noted at checkpoint 23. Findings R130–R188; AP003 deferred. Source edits at checkpoint 23: argumentsForm.ts/elicitation.ts once each, their tests twice each. Do not reopen.

#### Git AI content boundary reclassified from section 15 — DONE (1 files)

- DONE `src-tauri/src/modules/git/ai_diff.rs` — LOCAL-ONLY

#### Dedicated content-import policy reclassified from section 10 — DONE (1 files)

- DONE `src-tauri/src/modules/secret_paths.rs` — LOCAL-ONLY

#### `docs/architecture/` — DONE (1 files)

- DONE `docs/architecture/ai-subsystem.md` — PR

#### `src-tauri/examples/` — DONE (1 files)

- DONE `src-tauri/examples/network_page_probe.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/` — DONE (11 files)

- DONE `src-tauri/src/modules/clipboard_snapshot.rs` — LOCAL-ONLY; AI-only implementation reviewed at checkpoint 18

- DONE `src-tauri/src/modules/agent.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/ai_chat_control.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/ai_endpoints.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/ai_metadata.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/ai_sessions.rs` — PR
- DONE `src-tauri/src/modules/ai_subagents.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/net.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/project_memory.rs` — PR
- DONE `src-tauri/src/modules/project_trust.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/secrets.rs` — PR+LOCAL

#### `src-tauri/src/modules/fs/` — DONE (1 files)

- DONE `src-tauri/src/modules/fs/attachment.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/mcp/` — DONE (14 files)

- DONE `src-tauri/src/modules/mcp/credentials.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/mcp/framing.rs` — PR
- DONE `src-tauri/src/modules/mcp/http.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/import.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/jsonc.rs` — PR
- DONE `src-tauri/src/modules/mcp/leases.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/mcp/logs.rs` — PR
- DONE `src-tauri/src/modules/mcp/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/names.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/project.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/settings.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/mcp/status.rs` — PR
- DONE `src-tauri/src/modules/mcp/stdio.rs` — PR
- DONE `src-tauri/src/modules/mcp/storage.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/mcp/oauth/` — DONE (10 files)

- DONE `src-tauri/src/modules/mcp/oauth/callback.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/oauth/challenge.rs` — PR
- DONE `src-tauri/src/modules/mcp/oauth/discovery.rs` — PR
- DONE `src-tauri/src/modules/mcp/oauth/fetch.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/oauth/flow.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/oauth/live_tests.rs` — PR
- DONE `src-tauri/src/modules/mcp/oauth/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/oauth/pkce.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/mcp/oauth/probe.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/mcp/oauth/store.rs` — PR+LOCAL

#### `src-tauri/src/modules/net/` — DONE (8 files)

- DONE `src-tauri/src/modules/net/clients.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/net/clients_boundary_tests.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/net/deadline.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/net/dns.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/net/image.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/net/page.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/net/probe.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/net/stream.rs` — PR+LOCAL

#### `src-tauri/src/modules/secrets/` — DONE (2 files)

- DONE `src-tauri/src/modules/secrets/file.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/secrets/generations.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/shell/` — DONE (7 files)

- DONE `src-tauri/src/modules/shell/background.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/shell/cwd_frame.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/shell/detached.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/shell/job_registry.rs` — LOCAL-ONLY
- DONE `src-tauri/src/modules/shell/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/shell/session.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/shell/session_registry.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/skills/` — DONE (7 files)

- DONE `src-tauri/src/modules/skills/discover.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/skills/files.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/skills/frontmatter.rs` — PR
- DONE `src-tauri/src/modules/skills/install.rs` — PR
- DONE `src-tauri/src/modules/skills/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/skills/trash.rs` — PR
- DONE `src-tauri/src/modules/skills/watch.rs` — PR

#### `src-tauri/tests/` — DONE (2 files)

- DONE `src-tauri/tests/git_ai_diff.rs` — LOCAL-ONLY
- DONE `src-tauri/tests/shell_background.rs` — PR+LOCAL

#### `src/app/hooks/` — DONE (2 files)

- DONE `src/app/hooks/aiToggle.test.ts` — PR
- DONE `src/app/hooks/aiToggle.ts` — PR

#### `src/components/ai-elements/` — DONE (9 files)

- DONE `src/components/ai-elements/chat-code-lezer.ts` — PR
- DONE `src/components/ai-elements/chat-code.tsx` — PR+LOCAL
- DONE `src/components/ai-elements/context.tsx` — PR
- DONE `src/components/ai-elements/markdown-code.test.tsx` — PR
- DONE `src/components/ai-elements/markdown-code.tsx` — PR
- DONE `src/components/ai-elements/message.tsx` — PR
- DONE `src/components/ai-elements/shimmer.tsx` — PR
- DONE `src/components/ai-elements/snippet.tsx` — LOCAL-ONLY
- DONE `src/components/ai-elements/tool.tsx` — PR+LOCAL

#### `src/lib/` — DONE (2 files)

- DONE `src/lib/networkPage.test.ts` — LOCAL-ONLY
- DONE `src/lib/networkPage.ts` — LOCAL-ONLY

#### `src/modules/agents/` — DONE (1 files)

- DONE `src/modules/agents/index.ts` — PR

#### `src/modules/agents/components/` — DONE (3 files)

- DONE `src/modules/agents/components/AgentLauncherPanel.tsx` — PR
- DONE `src/modules/agents/components/AgentNotificationsBridge.tsx` — PR
- DONE `src/modules/agents/components/NotificationBell.tsx` — PR

#### `src/modules/agents/lib/` — DONE (10 files)

- DONE `src/modules/agents/lib/agentIcon.test.tsx` — PR
- DONE `src/modules/agents/lib/agentIcon.tsx` — PR
- DONE `src/modules/agents/lib/delivery.test.ts` — PR
- DONE `src/modules/agents/lib/format.test.ts` — PR
- DONE `src/modules/agents/lib/format.ts` — PR
- DONE `src/modules/agents/lib/launcher.test.ts` — PR
- DONE `src/modules/agents/lib/launcher.ts` — PR
- DONE `src/modules/agents/lib/notify.ts` — PR
- DONE `src/modules/agents/lib/review.test.ts` — PR
- DONE `src/modules/agents/lib/review.ts` — PR

#### `src/modules/agents/store/` — DONE (4 files)

- DONE `src/modules/agents/store/agentStore.test.ts` — PR
- DONE `src/modules/agents/store/agentStore.ts` — PR
- DONE `src/modules/agents/store/managedAgentsStore.test.ts` — PR
- DONE `src/modules/agents/store/managedAgentsStore.ts` — PR

#### `src/modules/ai/` — DONE (2 files)

- DONE `src/modules/ai/config.test.ts` — PR+LOCAL
- DONE `src/modules/ai/config.ts` — PR+LOCAL

#### `src/modules/ai/agents/` — DONE (4 files)

- DONE `src/modules/ai/agents/runSubagent.test.ts` — PR+LOCAL
- DONE `src/modules/ai/agents/runSubagent.ts` — PR+LOCAL
- DONE `src/modules/ai/agents/trackedSubagent.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/agents/trackedSubagent.ts` — LOCAL-ONLY

#### `src/modules/ai/components/` — DONE (24 files)

- DONE `src/modules/ai/components/AgentRunBridge.tsx` — PR+LOCAL
- DONE `src/modules/ai/components/AgentStatusPill.tsx` — PR
- DONE `src/modules/ai/components/AiChat.tsx` — PR+LOCAL
- DONE `src/modules/ai/components/AiComposerInput.tsx` — PR+LOCAL
- DONE `src/modules/ai/components/AiInputBar.test.ts` — PR
- DONE `src/modules/ai/components/AiInputBar.tsx` — PR
- DONE `src/modules/ai/components/AiMiniWindow.tsx` — PR+LOCAL
- DONE `src/modules/ai/components/AiStatusBarControls.tsx` — PR+LOCAL
- DONE `src/modules/ai/components/AiToolApproval.tsx` — PR
- DONE `src/modules/ai/components/AllFoldersChip.tsx` — PR
- DONE `src/modules/ai/components/ApprovalModeControl.tsx` — PR
- DONE `src/modules/ai/components/ChipsRow.tsx` — PR
- DONE `src/modules/ai/components/FilePicker.tsx` — PR
- DONE `src/modules/ai/components/LocalAgentNotificationsBridge.tsx` — PR
- DONE `src/modules/ai/components/McpTool.tsx` — PR+LOCAL
- DONE `src/modules/ai/components/PlanDiffReview.tsx` — PR
- DONE `src/modules/ai/components/ReasoningEffortPicker.tsx` — PR
- DONE `src/modules/ai/components/SelectionAskAi.tsx` — PR
- DONE `src/modules/ai/components/SnippetPicker.tsx` — PR
- DONE `src/modules/ai/components/SubagentTasksButton.tsx` — LOCAL-ONLY
- DONE `src/modules/ai/components/SubagentTasksDialog.tsx` — LOCAL-ONLY
- DONE `src/modules/ai/components/lazy.tsx` — PR
- DONE `src/modules/ai/components/messageHeightEstimate.test.ts` — PR
- DONE `src/modules/ai/components/messageHeightEstimate.ts` — PR

#### `src/modules/ai/hooks/` — DONE (6 files)

- DONE `src/modules/ai/hooks/useAiBootstrap.keys.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/hooks/useAiBootstrap.ts` — LOCAL-ONLY
- DONE `src/modules/ai/hooks/useSelectionAskAi.test.ts` — PR
- DONE `src/modules/ai/hooks/useSelectionAskAi.ts` — PR
- DONE `src/modules/ai/hooks/useWhisperRecording.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/hooks/useWhisperRecording.ts` — LOCAL-ONLY

#### `src/modules/ai/lib/` — DONE (98 files)

- DONE `src/modules/ai/lib/agent.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/agent.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/agents.ts` — PR
- DONE `src/modules/ai/lib/aiSurface.test.ts` — PR
- DONE `src/modules/ai/lib/aiSurface.ts` — PR
- DONE `src/modules/ai/lib/approvalMode.test.ts` — PR
- DONE `src/modules/ai/lib/approvalMode.ts` — PR
- DONE `src/modules/ai/lib/approvalResponse.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/approvalResponse.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/chatWork.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/chatWork.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/codeHighlight.test.ts` — PR
- DONE `src/modules/ai/lib/commandMessage.test.ts` — PR
- DONE `src/modules/ai/lib/commandMessage.ts` — PR
- DONE `src/modules/ai/lib/compact.test.ts` — PR
- DONE `src/modules/ai/lib/compact.ts` — PR
- DONE `src/modules/ai/lib/composer.submit.test.tsx` — LOCAL-ONLY
- DONE `src/modules/ai/lib/composer.tsx` — PR+LOCAL
- DONE `src/modules/ai/lib/composerDrop.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/composerDrop.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/composerImports.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/composerImports.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/composerKeys.test.ts` — PR
- DONE `src/modules/ai/lib/composerKeys.ts` — PR
- DONE `src/modules/ai/lib/composerTriggers.test.ts` — PR
- DONE `src/modules/ai/lib/composerTriggers.ts` — PR
- DONE `src/modules/ai/lib/composerWork.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/composerWork.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/credentialState.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/endpointCredentials.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/endpointCredentials.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/endpointModels.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/endpointModels.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/endpointPresets.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/endpointPresets.ts` — PR
- DONE `src/modules/ai/lib/errors.test.ts` — PR
- DONE `src/modules/ai/lib/errors.ts` — PR
- DONE `src/modules/ai/lib/imageAttachment.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/imageAttachment.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/keyring.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/keyring.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/maskKey.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/mcpHistory.test.ts` — PR
- DONE `src/modules/ai/lib/mcpHistory.ts` — PR
- DONE `src/modules/ai/lib/mcpRunLeases.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/mcpRunLeases.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/messageBlocks.test.ts` — PR
- DONE `src/modules/ai/lib/messageBlocks.ts` — PR
- DONE `src/modules/ai/lib/messageChips.test.ts` — PR
- DONE `src/modules/ai/lib/messageChips.ts` — PR
- DONE `src/modules/ai/lib/modelPrefs.test.ts` — PR
- DONE `src/modules/ai/lib/modelPrefs.ts` — PR
- DONE `src/modules/ai/lib/modelResolution.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/modelTarget.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/modelTarget.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/native.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/native.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/networkPage.integration.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/opencodeSession.test.ts` — PR
- DONE `src/modules/ai/lib/opencodeSession.ts` — PR
- DONE `src/modules/ai/lib/ownedStream.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/ownedStream.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/pastedImages.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/pastedImages.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/pathAttachment.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/pathAttachment.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/proxyFetch.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/proxyFetch.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/reasoningDisplay.test.ts` — PR
- DONE `src/modules/ai/lib/reasoningDisplay.ts` — PR
- DONE `src/modules/ai/lib/reasoningEffort.test.ts` — PR
- DONE `src/modules/ai/lib/reasoningEffort.ts` — PR
- DONE `src/modules/ai/lib/secretPaths.json` — PR+LOCAL
- DONE `src/modules/ai/lib/security.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/security.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/sessions.metadata.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/sessions.persistence.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/sessions.test.ts` — PR
- DONE `src/modules/ai/lib/sessions.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/slashCommands.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/slashCommands.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/snippets.ts` — PR
- DONE `src/modules/ai/lib/stt.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/stt.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/todos.ts` — PR
- DONE `src/modules/ai/lib/toolApprovals.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/toolApprovals.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/transport.test.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/transport.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/usage.test.ts` — PR
- DONE `src/modules/ai/lib/usage.ts` — PR
- DONE `src/modules/ai/lib/useAiLiveBridge.ts` — PR+LOCAL
- DONE `src/modules/ai/lib/useMiniWindowGeometry.ts` — PR
- DONE `src/modules/ai/lib/voiceConfiguration.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/voiceRecording.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/voiceRecording.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/wav.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/lib/wav.ts` — LOCAL-ONLY

#### `src/modules/ai/store/` — DONE (26 files)

- DONE `src/modules/ai/store/agentsStore.test.ts` — PR
- DONE `src/modules/ai/store/agentsStore.ts` — PR
- DONE `src/modules/ai/store/chatRuntime.background.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatRuntime.followUp.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatRuntime.preferences.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/store/chatRuntime.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatRuntime.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatStop.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/store/chatStop.ts` — LOCAL-ONLY
- DONE `src/modules/ai/store/chatStore.approval.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatStore.eviction.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatStore.hydration.test.ts` — PR
- DONE `src/modules/ai/store/chatStore.persist.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatStore.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatStore.ts` — PR+LOCAL
- DONE `src/modules/ai/store/chatStore.windows.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/modelConfig.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/modelConfig.ts` — PR+LOCAL
- DONE `src/modules/ai/store/planStore.failures.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/planStore.test.ts` — PR+LOCAL
- DONE `src/modules/ai/store/planStore.ts` — PR+LOCAL
- DONE `src/modules/ai/store/snippetsStore.test.ts` — PR
- DONE `src/modules/ai/store/snippetsStore.ts` — PR
- DONE `src/modules/ai/store/subagentTasks.test.ts` — LOCAL-ONLY
- DONE `src/modules/ai/store/subagentTasks.ts` — LOCAL-ONLY
- DONE `src/modules/ai/store/todoStore.test.ts` — PR

#### `src/modules/ai/tools/` — DONE (25 files)

- DONE `src/modules/ai/tools/agent.test.ts` — PR
- DONE `src/modules/ai/tools/agent.ts` — PR
- DONE `src/modules/ai/tools/allFolders.test.ts` — PR
- DONE `src/modules/ai/tools/context.test.ts` — PR
- DONE `src/modules/ai/tools/context.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/edit.test.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/edit.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/fs.test.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/fs.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/readCache.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/search.test.ts` — PR
- DONE `src/modules/ai/tools/search.ts` — LOCAL-ONLY
- DONE `src/modules/ai/tools/shell.test.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/shell.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/skills.test.ts` — PR
- DONE `src/modules/ai/tools/skills.ts` — PR
- DONE `src/modules/ai/tools/subagent.conversation.test.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/subagent.test.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/subagent.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/terminal.test.ts` — PR
- DONE `src/modules/ai/tools/textWindow.test.ts` — PR
- DONE `src/modules/ai/tools/textWindow.ts` — PR
- DONE `src/modules/ai/tools/todo.test.ts` — PR
- DONE `src/modules/ai/tools/tools.test.ts` — PR+LOCAL
- DONE `src/modules/ai/tools/tools.ts` — PR+LOCAL

#### `src/modules/editor/lib/autocomplete/` — DONE (10 files)

- DONE `src/modules/editor/lib/autocomplete/configuration.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/configuration.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/credential.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/credential.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/inlineExtension.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/inlineExtension.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/autocomplete/preferences.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/prompt.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/provider.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/autocomplete/provider.ts` — PR+LOCAL

#### `src/modules/mcp/` — DONE (8 files)

- DONE `src/modules/mcp/composer.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/composer.ts` — PR+LOCAL
- DONE `src/modules/mcp/extras.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/extras.ts` — PR+LOCAL
- DONE `src/modules/mcp/index.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/index.ts` — PR+LOCAL
- DONE `src/modules/mcp/slash.test.ts` — PR
- DONE `src/modules/mcp/slash.ts` — PR

#### `src/modules/mcp/components/` — DONE (6 files)

- DONE `src/modules/mcp/components/ArgumentsForm.tsx` — PR
- DONE `src/modules/mcp/components/ElicitationCard.test.tsx` — PR
- DONE `src/modules/mcp/components/ElicitationCard.tsx` — PR
- DONE `src/modules/mcp/components/McpElicitations.tsx` — PR
- DONE `src/modules/mcp/components/McpRequestsHost.tsx` — PR
- DONE `src/modules/mcp/components/SamplingDialog.tsx` — PR

#### `src/modules/mcp/lib/` — DONE (50 files)

- DONE `src/modules/mcp/lib/argumentsForm.test.ts` — PR
- DONE `src/modules/mcp/lib/argumentsForm.ts` — PR
- DONE `src/modules/mcp/lib/auth.test.ts` — PR
- DONE `src/modules/mcp/lib/auth.ts` — PR+LOCAL
- DONE `src/modules/mcp/lib/blocks.test.ts` — PR
- DONE `src/modules/mcp/lib/blocks.ts` — PR
- DONE `src/modules/mcp/lib/catalog.test.ts` — PR
- DONE `src/modules/mcp/lib/catalog.ts` — PR
- DONE `src/modules/mcp/lib/commandLine.test.ts` — PR
- DONE `src/modules/mcp/lib/commandLine.ts` — PR
- DONE `src/modules/mcp/lib/config.test.ts` — PR
- DONE `src/modules/mcp/lib/config.ts` — PR+LOCAL
- DONE `src/modules/mcp/lib/configStore.test.ts` — LOCAL-ONLY
- DONE `src/modules/mcp/lib/configStore.ts` — PR+LOCAL
- DONE `src/modules/mcp/lib/displayText.test.ts` — PR
- DONE `src/modules/mcp/lib/displayText.ts` — PR
- DONE `src/modules/mcp/lib/elicitation.test.ts` — PR
- DONE `src/modules/mcp/lib/elicitation.ts` — PR
- DONE `src/modules/mcp/lib/extrasCatalog.test.ts` — PR
- DONE `src/modules/mcp/lib/extrasCatalog.ts` — PR
- DONE `src/modules/mcp/lib/importConfig.test.ts` — PR
- DONE `src/modules/mcp/lib/importConfig.ts` — PR
- DONE `src/modules/mcp/lib/lifecycle.test.ts` — PR
- DONE `src/modules/mcp/lib/lifecycle.ts` — PR
- DONE `src/modules/mcp/lib/pickerItems.test.ts` — PR
- DONE `src/modules/mcp/lib/pickerItems.ts` — PR
- DONE `src/modules/mcp/lib/projectServers.test.ts` — PR
- DONE `src/modules/mcp/lib/projectServers.ts` — PR+LOCAL
- DONE `src/modules/mcp/lib/promptCommands.test.ts` — PR
- DONE `src/modules/mcp/lib/promptCommands.ts` — PR
- DONE `src/modules/mcp/lib/promptMessages.test.ts` — PR
- DONE `src/modules/mcp/lib/promptMessages.ts` — PR
- DONE `src/modules/mcp/lib/requests.test.ts` — PR
- DONE `src/modules/mcp/lib/requests.ts` — PR
- DONE `src/modules/mcp/lib/resourceAttachments.test.ts` — PR
- DONE `src/modules/mcp/lib/resourceAttachments.ts` — PR
- DONE `src/modules/mcp/lib/results.test.ts` — PR
- DONE `src/modules/mcp/lib/results.ts` — PR
- DONE `src/modules/mcp/lib/runServers.test.ts` — LOCAL-ONLY
- DONE `src/modules/mcp/lib/runServers.ts` — LOCAL-ONLY
- DONE `src/modules/mcp/lib/sampling.test.ts` — PR
- DONE `src/modules/mcp/lib/sampling.ts` — PR
- DONE `src/modules/mcp/lib/settingsPatch.test.ts` — LOCAL-ONLY
- DONE `src/modules/mcp/lib/settingsPatch.ts` — LOCAL-ONLY
- DONE `src/modules/mcp/lib/status.test.ts` — PR
- DONE `src/modules/mcp/lib/status.ts` — PR
- DONE `src/modules/mcp/lib/toolNames.test.ts` — PR
- DONE `src/modules/mcp/lib/toolNames.ts` — PR
- DONE `src/modules/mcp/lib/toolSchema.test.ts` — PR
- DONE `src/modules/mcp/lib/toolSchema.ts` — PR

#### `src/modules/mcp/runtime/` — DONE (13 files)

- DONE `src/modules/mcp/runtime/ajvProvider.ts` — PR
- DONE `src/modules/mcp/runtime/connect.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/connect.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/extras.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/extras.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/index.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/index.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/manager.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/manager.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/serverRequests.test.ts` — PR
- DONE `src/modules/mcp/runtime/serverRequests.ts` — PR
- DONE `src/modules/mcp/runtime/stdioTransport.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/runtime/stdioTransport.ts` — PR+LOCAL

#### `src/modules/mcp/sampling/` — DONE (5 files)

- DONE `src/modules/mcp/sampling/flow.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/sampling/models.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/sampling/models.ts` — PR
- DONE `src/modules/mcp/sampling/run.test.ts` — PR+LOCAL
- DONE `src/modules/mcp/sampling/run.ts` — PR+LOCAL

#### `src/modules/settings/` — DONE (5 files)

- DONE `src/modules/settings/aiStopBackgroundJobs.test.ts` — LOCAL-ONLY
- DONE `src/modules/settings/customEndpoints.test.ts` — PR+LOCAL
- DONE `src/modules/settings/endpoints.test.ts` — LOCAL-ONLY
- DONE `src/modules/settings/endpoints.ts` — LOCAL-ONLY
- DONE `src/modules/settings/selectionAskAi.test.ts` — PR+LOCAL

#### `src/modules/skills/` — DONE (26 files)

- DONE `src/modules/skills/ProjectTrustPrompt.test.tsx` — PR
- DONE `src/modules/skills/ProjectTrustPrompt.tsx` — PR
- DONE `src/modules/skills/SkillsBridge.tsx` — PR
- DONE `src/modules/skills/SkillsWatcher.tsx` — PR
- DONE `src/modules/skills/api.ts` — PR
- DONE `src/modules/skills/catalog.test.ts` — PR
- DONE `src/modules/skills/catalog.ts` — PR
- DONE `src/modules/skills/composer.test.ts` — PR
- DONE `src/modules/skills/composer.ts` — PR
- DONE `src/modules/skills/fixtures.ts` — PR
- DONE `src/modules/skills/index.ts` — PR
- DONE `src/modules/skills/invocation.test.ts` — PR
- DONE `src/modules/skills/invocation.ts` — PR
- DONE `src/modules/skills/names.test.ts` — PR
- DONE `src/modules/skills/names.ts` — PR
- DONE `src/modules/skills/prompt.test.ts` — PR
- DONE `src/modules/skills/prompt.ts` — PR
- DONE `src/modules/skills/settingsView.test.ts` — PR
- DONE `src/modules/skills/settingsView.ts` — PR
- DONE `src/modules/skills/slash.test.ts` — PR
- DONE `src/modules/skills/slash.ts` — PR
- DONE `src/modules/skills/trust.test.ts` — PR
- DONE `src/modules/skills/trust.ts` — PR
- DONE `src/modules/skills/types.ts` — PR
- DONE `src/modules/skills/useSkillEditRequests.ts` — PR
- DONE `src/modules/skills/useUserSkills.ts` — PR

#### `src/settings/components/` — DONE (4 files)

- DONE `src/settings/components/CredentialRecovery.tsx` — LOCAL-ONLY
- DONE `src/settings/components/ModelBrowseButton.test.tsx` — LOCAL-ONLY
- DONE `src/settings/components/ModelBrowseButton.tsx` — PR+LOCAL
- DONE `src/settings/components/ProviderKeyCard.tsx` — LOCAL-ONLY

#### `src/settings/components/skills/` — DONE (2 files)

- DONE `src/settings/components/skills/InstallSkillsDialog.tsx` — PR
- DONE `src/settings/components/skills/NewSkillDialog.tsx` — PR

#### `src/settings/sections/` — DONE (10 files)

- DONE `src/settings/sections/AgentsSection.tsx` — PR+LOCAL
- DONE `src/settings/sections/McpTab.tsx` — PR
- DONE `src/settings/sections/ModelsSection.removal.test.tsx` — LOCAL-ONLY
- DONE `src/settings/sections/ModelsSection.tsx` — PR+LOCAL
- DONE `src/settings/sections/SkillsSection.tsx` — PR
- DONE `src/settings/sections/endpointPing.lifecycle.test.ts` — LOCAL-ONLY
- DONE `src/settings/sections/endpointPing.test.ts` — PR+LOCAL
- DONE `src/settings/sections/endpointPing.ts` — PR+LOCAL
- DONE `src/settings/sections/endpointProbe.test.ts` — LOCAL-ONLY
- DONE `src/settings/sections/endpointProbe.ts` — LOCAL-ONLY

#### `src/settings/sections/mcp/` — DONE (16 files)

- DONE `src/settings/sections/mcp/ImportDialog.tsx` — PR+LOCAL
- DONE `src/settings/sections/mcp/McpSection.load.test.ts` — LOCAL-ONLY
- DONE `src/settings/sections/mcp/McpSection.tsx` — PR+LOCAL
- DONE `src/settings/sections/mcp/ProjectServers.test.tsx` — PR
- DONE `src/settings/sections/mcp/ProjectServers.tsx` — PR
- DONE `src/settings/sections/mcp/ServerDialog.tsx` — PR+LOCAL
- DONE `src/settings/sections/mcp/ServerLogs.tsx` — PR+LOCAL
- DONE `src/settings/sections/mcp/SignIn.races.test.ts` — LOCAL-ONLY
- DONE `src/settings/sections/mcp/SignIn.test.tsx` — PR+LOCAL
- DONE `src/settings/sections/mcp/SignIn.tsx` — PR+LOCAL
- DONE `src/settings/sections/mcp/discoveryQueue.test.ts` — LOCAL-ONLY
- DONE `src/settings/sections/mcp/discoveryQueue.ts` — LOCAL-ONLY
- DONE `src/settings/sections/mcp/draft.test.ts` — PR
- DONE `src/settings/sections/mcp/draft.ts` — PR
- DONE `src/settings/sections/mcp/metadataProbe.test.ts` — LOCAL-ONLY
- DONE `src/settings/sections/mcp/metadataProbe.ts` — LOCAL-ONLY

### F2 — Preview code and fixes

Status: **DONE (62/62 files reviewed)**. Review time: 189 s at checkpoint 23, below ten-minute cap. Native asset service, Markdown transforms/rendering/image leases and browser preview ownership inspected; large tests/CSS sampled and deleted test read from PR base. Findings R189–R195. localImages.ts edited once and its test twice. No native code changed. Do not reopen.

#### Preview-only paths reclassified from section 09 — DONE (3 files)

- DONE `src-tauri/src/modules/asset_all_folders.rs` — PR
- DONE `src/modules/workspace/assetUrl.ts` — PR+LOCAL
- DONE `src/modules/workspace/assetUrl.test.ts` — PR

#### `scripts/preview-review/` — DONE (1 files)

- DONE `scripts/preview-review/README.md` — LOCAL-ONLY

#### `src/modules/markdown/` — DONE (46 files)

- DONE `src/modules/markdown/MarkdownImage.lifecycle.test.tsx` — LOCAL-ONLY
- DONE `src/modules/markdown/MarkdownImage.tsx` — PR+LOCAL
- DONE `src/modules/markdown/MarkdownLink.test.tsx` — PR
- DONE `src/modules/markdown/MarkdownLink.tsx` — PR
- DONE `src/modules/markdown/MarkdownPreviewPane.test.ts` — PR; deleted/missing in working copy
- DONE `src/modules/markdown/MarkdownPreviewPane.tsx` — PR+LOCAL
- DONE `src/modules/markdown/MarkdownStack.tsx` — LOCAL-ONLY
- DONE `src/modules/markdown/MermaidBlock.test.tsx` — PR
- DONE `src/modules/markdown/MermaidBlock.tsx` — PR
- DONE `src/modules/markdown/MermaidDiagram.tsx` — PR
- DONE `src/modules/markdown/MermaidViews.tsx` — PR
- DONE `src/modules/markdown/PreviewCode.test.tsx` — PR
- DONE `src/modules/markdown/PreviewCode.tsx` — PR
- DONE `src/modules/markdown/PreviewLink.test.tsx` — PR
- DONE `src/modules/markdown/PreviewLink.tsx` — PR
- DONE `src/modules/markdown/RenderBoundary.test.tsx` — PR
- DONE `src/modules/markdown/RenderBoundary.tsx` — PR
- DONE `src/modules/markdown/RenderedMarkdown.test.tsx` — PR
- DONE `src/modules/markdown/RenderedMarkdown.tsx` — PR
- DONE `src/modules/markdown/documentLinks.ts` — PR
- DONE `src/modules/markdown/dollarMath.test.ts` — PR
- DONE `src/modules/markdown/dollarMath.ts` — PR
- DONE `src/modules/markdown/frontmatter.test.ts` — PR
- DONE `src/modules/markdown/frontmatter.ts` — PR
- DONE `src/modules/markdown/githubAlerts.test.tsx` — PR
- DONE `src/modules/markdown/githubAlerts.ts` — PR
- DONE `src/modules/markdown/hast.ts` — PR
- DONE `src/modules/markdown/headingAnchors.test.tsx` — PR
- DONE `src/modules/markdown/headingAnchors.ts` — PR
- DONE `src/modules/markdown/localImages.test.tsx` — PR+LOCAL
- DONE `src/modules/markdown/localImages.ts` — PR
- DONE `src/modules/markdown/markdownPreview.css` — PR
- DONE `src/modules/markdown/math.css` — PR
- DONE `src/modules/markdown/math.test.tsx` — PR
- DONE `src/modules/markdown/math.ts` — PR
- DONE `src/modules/markdown/mathPlugin.ts` — PR
- DONE `src/modules/markdown/mermaidRender.test.ts` — PR
- DONE `src/modules/markdown/mermaidRender.ts` — PR
- DONE `src/modules/markdown/pictures.ts` — PR
- DONE `src/modules/markdown/previewPipeline.ts` — PR
- DONE `src/modules/markdown/previewStatus.test.ts` — PR
- DONE `src/modules/markdown/previewStatus.ts` — PR
- DONE `src/modules/markdown/remoteImageRequest.test.ts` — LOCAL-ONLY
- DONE `src/modules/markdown/remoteImageRequest.ts` — LOCAL-ONLY
- DONE `src/modules/markdown/remoteImages.test.ts` — PR+LOCAL
- DONE `src/modules/markdown/remoteImages.ts` — PR+LOCAL

#### `src/modules/preview/` — DONE (6 files)

- DONE `src/modules/preview/PreviewAddressBar.lifetime.test.tsx` — LOCAL-ONLY
- DONE `src/modules/preview/PreviewAddressBar.tsx` — PR+LOCAL
- DONE `src/modules/preview/PreviewPane.tsx` — LOCAL-ONLY
- DONE `src/modules/preview/PreviewStack.ownership.test.tsx` — LOCAL-ONLY
- DONE `src/modules/preview/PreviewStack.tsx` — LOCAL-ONLY
- DONE `src/modules/preview/index.ts` — PR

#### `src/modules/preview/lib/` — DONE (6 files)

- DONE `src/modules/preview/lib/frameFocus.test.ts` — PR
- DONE `src/modules/preview/lib/frameFocus.ts` — PR
- DONE `src/modules/preview/lib/portProbe.test.ts` — LOCAL-ONLY
- DONE `src/modules/preview/lib/portProbe.ts` — LOCAL-ONLY
- DONE `src/modules/preview/lib/previewUrl.test.ts` — PR
- DONE `src/modules/preview/lib/previewUrl.ts` — PR

### F3 — XML and language override code

Status: **DONE (14/14 files reviewed)**. Review time: 221 s at checkpoint 24, below ten-minute cap. Large Vim forks sampled by changed/control-flow paths; language helpers/tests and review probes inspected. Findings R196–R200; R196 fixed. vim.js and new range.test.js each edited twice. Do not reopen.

#### `packages/codemirror-vim/` — DONE (2 files)

- DONE `packages/codemirror-vim/index.js` — LOCAL-ONLY
- DONE `packages/codemirror-vim/range.test.js` — LOCAL-ONLY; added at checkpoint 24 for R196

#### `packages/codemirror-vim-core/` — DONE (1 files)

- DONE `packages/codemirror-vim-core/vim.js` — LOCAL-ONLY

#### `scripts/vim-review/` — DONE (2 files)

- DONE `scripts/vim-review/probe.ts` — LOCAL-ONLY
- DONE `scripts/vim-review/upstream-probe.js` — LOCAL-ONLY

#### `src/modules/editor/lib/` — DONE (9 files)

- DONE `src/modules/editor/lib/documentLanguage.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/documentLanguage.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/languageDefinitions.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/languageResolver.test.ts` — PR
- DONE `src/modules/editor/lib/languageResolver.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/useDocumentLanguage.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/useDocumentLanguage.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/vim.test.ts` — LOCAL-ONLY
- DONE `src/modules/editor/lib/vim.ts` — LOCAL-ONLY

### F4 — Theme storage, transactions and snapshots

Status: **DONE (14/14 files reviewed)**. Review time: 122 s at checkpoint 24, below ten-minute cap. Native catalog transactions, recovery, frontend snapshots, file-edit workflow, Settings and assigned tests inspected. Findings R201–R209; K001 remains log-only. Source edits: 0. Do not reopen.

#### `scripts/theme-review/` — DONE (1 files)

- DONE `scripts/theme-review/README.md` — LOCAL-ONLY

#### `src-tauri/src/modules/` — DONE (1 files)

- DONE `src-tauri/src/modules/themes.rs` — LOCAL-ONLY

#### `src/modules/theme/` — DONE (10 files)

- DONE `src/modules/theme/ThemeProvider.tsx` — PR+LOCAL
- DONE `src/modules/theme/customThemes.test.ts` — PR+LOCAL
- DONE `src/modules/theme/customThemes.ts` — PR+LOCAL
- DONE `src/modules/theme/index.ts` — PR
- DONE `src/modules/theme/themeDeletion.test.ts` — LOCAL-ONLY
- DONE `src/modules/theme/themeDeletion.ts` — LOCAL-ONLY
- DONE `src/modules/theme/themeFiles.persistence.test.ts` — PR
- DONE `src/modules/theme/themeFiles.test.ts` — PR
- DONE `src/modules/theme/themeFiles.ts` — PR
- DONE `src/modules/theme/useThemeFileEditing.ts` — PR+LOCAL

#### `src/settings/components/` — DONE (1 files)

- DONE `src/settings/components/ThemePastePanel.tsx` — PR

#### `src/settings/sections/` — DONE (1 files)

- DONE `src/settings/sections/ThemesSection.tsx` — PR+LOCAL

### F5 — Shared integration files (formerly held as frozen)

Status: **DONE (25/25 files reviewed)**. Review time: 330 s at checkpoint 25, below ten-minute cap. Large integration files/tests and historical documentation sampled; see checkpoint limits. Findings R210–R221, all log-only. Source edits: 0. Do not reopen.

#### `./` — DONE (1 files)

- DONE `AGENTS.md` — PR+LOCAL

#### `docs/` — DONE (1 files)

- DONE `docs/pr-1-review-coverage.md` — LOCAL-ONLY

#### `src-tauri/src/` — DONE (1 files)

- DONE `src-tauri/src/lib.rs` — PR+LOCAL

#### `src-tauri/src/modules/` — DONE (2 files)

- DONE `src-tauri/src/modules/mod.rs` — PR+LOCAL
- DONE `src-tauri/src/modules/store_scope.rs` — PR+LOCAL

#### `src-tauri/src/modules/fs/` — DONE (1 files)

- DONE `src-tauri/src/modules/fs/formatter.rs` — LOCAL-ONLY

#### `src-tauri/src/modules/pty/` — DONE (1 files)

- DONE `src-tauri/src/modules/pty/agent_detect.rs` — PR+LOCAL

#### `src/app/` — DONE (1 files)

- DONE `src/app/App.tsx` — PR+LOCAL

#### `src/app/components/` — DONE (2 files)

- DONE `src/app/components/WorkspaceInputBar.tsx` — PR+LOCAL
- DONE `src/app/components/WorkspaceSurface.tsx` — LOCAL-ONLY

#### `src/modules/editor/` — DONE (2 files)

- DONE `src/modules/editor/EditorPane.test.ts` — PR
- DONE `src/modules/editor/EditorPane.tsx` — PR+LOCAL

#### `src/modules/editor/lib/` — DONE (7 files)

- DONE `src/modules/editor/lib/documentSession.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/documentSession.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/extensions.test.ts` — PR
- DONE `src/modules/editor/lib/extensions.ts` — PR
- DONE `src/modules/editor/lib/externalFormat.test.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/externalFormat.ts` — PR+LOCAL
- DONE `src/modules/editor/lib/externalFormat.workspace.test.ts` — LOCAL-ONLY

#### `src/modules/lsp/lib/` — DONE (2 files)

- DONE `src/modules/lsp/lib/useLspExtension.lifecycle.test.ts` — LOCAL-ONLY
- DONE `src/modules/lsp/lib/useLspExtension.ts` — LOCAL-ONLY

#### `src/modules/statusbar/` — DONE (1 files)

- DONE `src/modules/statusbar/StatusBar.tsx` — PR+LOCAL

#### `src/modules/terminal/lib/` — DONE (2 files)

- DONE `src/modules/terminal/lib/agentActivity.ts` — PR
- DONE `src/modules/terminal/lib/agentSignals.test.ts` — PR

#### `src/settings/` — DONE (1 files)

- DONE `src/settings/SettingsApp.tsx` — PR

## Rename-source inventory

These old names appear in the local base-to-head comparison but not as standalone filenames in GitHub’s inventory. They are inspected with the corresponding removal/rename and are not added to GitHub’s 1,251-file count. The three entries left unverified after their original sections were inspected under explicit authorization at checkpoint 26.

- DONE `packages/ghostty-core/adapted/wasm/src/terax.zig` — section 23; base source compared with `oarlock.zig` at checkpoint 26; see evidence and sampling limits above
- DONE `packages/ghostty-core/lib/adapted/TeraxGhostty.ts` — section 23; base source compared with `OarlockGhostty.ts` at checkpoint 26; see evidence and sampling limits above
- DONE `src-tauri/crates/terax-cli/Cargo.toml` — section 03; rename compared to current counterpart
- DONE `src-tauri/crates/terax-cli/src/main.rs` — section 03; rename compared to current counterpart
- DONE `src-tauri/crates/terax-control-protocol/src/lib.rs` — section 03; rename compared to current counterpart
- DONE `src/modules/theme/themes/terax-default.ts` — section 25; base source compared with `oarlock-default.ts` at checkpoint 26; see evidence and sampling limits above

### Depth checkpoint — R044, R084, R086 and AP002 (2026-10-28)

Scoped validation only; no production or test-code edits. R084 retains the earlier production-function/real `/bin/sh` probe and is reproduced at that boundary; `bun run test src/modules/terminal/block/lib/pathComplete.test.ts` passed 20 tests, which do not establish safe insertion. R086 remains conditional source evidence, not a mounted UI or cross-workspace reproduction. Relevant evidence: `src/modules/terminal/block/lib/pathComplete.ts`, `shellEditor.ts`, `ShellInput.tsx`, `src/modules/terminal/lib/blockController.ts`, `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts`, and `src-tauri/src/modules/fs/tree.rs`.

R044: `git archive HEAD | tar -x -C /tmp/oarlock-r044-head` produced a tracked-source snapshot without touching `.git` or current generated files. Its `package.json` and lock use registry `@replit/codemirror-vim` 6.4.0 and registry core 0.1.0; the proposed local `packages/codemirror-vim*` directories are untracked, and current package/lock modifications select them. Thus a clean HEAD checkout does not contain this local broken entry; a clean install/build was not attempted, so its overall success is unverified. `rsync -a --exclude dist packages/codemirror-vim-core/ /tmp/oarlock-r044-proposed/` isolated the proposed source without ignored artifacts. `./node_modules/.bin/tsc --ignoreConfig --noEmit --skipLibCheck false --moduleResolution bundler --module esnext /tmp/oarlock-r044-proposed/main.d.ts` exited 2 with TS2307 for both `./dist/vim` and `./dist/types`; the first invocation without `--ignoreConfig` instead returned TS5112 and was corrected. Existing ignored `dist/vim.d.ts` and `dist/types.d.ts` can mask this direct declaration check. The application adapter's `index.d.ts` does not import core declarations and root `skipLibCheck` is true, so no current app check failure is inferred. Resolve the proposed package's published type contract before relying on it, but do not claim a demonstrated broken clean app checkout.

AP002 is a concrete proposal awaiting the user's choice, not implementation approval. Only this ledger was edited in this depth batch; temporary artifacts remain under `/tmp`. No dependency installation, network access, commit or push.

### AP002 implementation checkpoint (2026-10-28)

User approved the recommended implementation and tests. Inspected the current command bar, completion source and existing native path-drop shell verification. The terminal session retains its workspace and generation; the native drop verification rejects unknown or non-original shells, but its current interface also validates and translates actual dropped paths. Completion needs a safely bound request and a second acceptance-time check, with correct handling of directory continuation. No product or test code changed; no implementation or new test is claimed. AP002 remains approved but unfinished. The earlier 20 completion tests do not cover the reported injection. Stop before another depth batch.

### AP002 implementation progress checkpoint (2026-10-28)

Implemented an initial completion path that captures a terminal session, generation, cwd and workspace, uses the existing native shell verification before listing and again before insertion, and encodes supported literal arguments. The command bar now rejects ambiguous shell grammar and retains directory retriggering for supported quoted forms. Added `safePathCompletion.ts` and `safePathCompletion.test.ts`. Changes also touch `ShellInput.tsx`, `shellEditor.ts`, `terminalSessionApi.ts` and `useGhosttyTerminalSession.ts`; these files had prior working-tree changes which were not replaced.

**Not complete:** the promised controlled tests for stale native replies/acceptance, leaf switch/restart/close and changing editor state are not yet implemented. There is no mounted CodeMirror interaction test of the new source. Fish, PowerShell, cmd, Windows/WSL and Git Bash real-shell tests have not run on this macOS host. The previous generic document-word fallback in argument position was removed by the current implementation and needs an explicit compatibility review before accepting the change. In particular, 20 old path-completion tests still exercise the former helper rather than proving the command bar's new path. Do not mark R084/R086 fixed or AP002 complete on these results.

Validation so far: new parser/literal POSIX shell suite **22 passed**; previous completion/drop suites **32 passed**; `bun run check-types` passed; `bun run lint` passed with 80 warnings and one info; full frontend suite passed **5,457 tests / 586 files** with authorized localhost access. Its initial restricted run had two localhost-listener failures and one associated error. Logs: `/tmp/oarlock-ap002-{safe,existing,types-final,lint-final,full,full-unrestricted}.log`. No Rust code was changed. `shellEditor.ts` and `safePathCompletion.ts` have each been edited twice in this continuation; no file was edited a third time. No new depth batch started.

### AP002 depth implementation checkpoint (2026-10-28)

Implemented the approved terminal-owned completion contract. Captures retain the actual terminal session, PTY, workspace, cwd and monotonic cwd revision, and reject navigation, session replacement/restart, close, shell exit, prompt loss or cwd changes; command-bar leaf/mode/focus changes additionally invalidate their captured lifetime. Native original-shell verification runs before directory lookup and again before accepting a suggestion. Request and acceptance also require the original document and selection; the CodeMirror completion source applies an explicitly ranged, shell-quoted whole argument. POSIX, fish, PowerShell and cmd encoders use the existing drop quoting, with unsupported/ambiguous input declined. Directory suggestions can be completed again. Original shell identity uses the existing native PTY path-drop verification; no new native command or Rust change was needed.

The document-word fallback removed in the prior continuation is restored when file lookup yields no results (or fails), for unquoted, unambiguous literal words; it uses the same owner/shell checks and guarded acceptance. This is intentionally narrower for quoted or complex shell syntax, consistent with the approved refusal policy. Found and recorded R222 (duplicate notices on one shell-verification failure); no code cleanup or new architecture proposal.

Validation: the five focused suites pass **51 tests, 2 skipped**. Tests exercise delayed directory responses and delayed acceptance after owner, document, selection or shell change, the actual captured-owner predicate for session replacement/navigation/restart/close/cwd/prompt loss, cwd returning to its prior value, selection moving away and back, captured WSL workspace, fallback, and literal-insertion behavior. Owner and view tests use simulated states and mocked native calls; they are not mounted GUI or live WSL reproductions. Real `/bin/sh`, Bash and Zsh round-trip tests passed. Fish and PowerShell tests were skipped because they are not installed; real cmd, Windows/WSL, local Git Bash and mounted CodeMirror validation remain outstanding.

Frontend full suite: **5,485 passed / 2 skipped in 589 files**, after production changes; the separately added selection-return test passed afterward. Final focused tests include that addition. Type checks passed, lint passed with 80 existing warnings, and tracked-file whitespace checks passed. Clippy `--all-targets --locked -- -D warnings` passed. `cargo nextest` was unavailable; the required `cargo test --locked` fallback passed **1,540 tests with 3 ignored** with authorized access to localhost and macOS FSEvents. Its initial restricted run had 23 failures due unavailable local network/FSEvents and restricted filesystem operations; the authorized rerun passed. Logs: `/tmp/oarlock-ap002-v7-{focused,types,lint,clippy,native,cargo-test,cargo-test-unrestricted}.log`, `/tmp/oarlock-ap002-v6-full.log`, and `/tmp/oarlock-ap002-v6-shells.log`.

This continuation added six source/test paths (`ownedPathCompletion.ts`, `ownedPathCompletion.test.ts`, `completionOwnership.ts`, `completionOwnership.test.ts`, `safePathCompletion.realShells.test.ts`, `completionSelection.test.ts`), alongside the two files introduced in the preceding continuation. The 1,751-file breadth count is the historical inventory, not a claim those eight newly introduced paths were in the original PR. No implementation file was edited more than twice in this continuation. No commits, pushes, or further depth batch. Stop at this checkpoint; R044 remains conditional and unchanged.

### Depth checkpoint — R130/R131, AP002 regression (2026-10-28)

Validated R130 and R131 with an isolated scratch Rust crate under `/tmp/oarlock-r130-r131-probe`; its tested functions are copied directly from current `src-tauri/src/modules/agent.rs`, with a temporary test module, not a live-app or real-settings test. All four deliberately failing assertions reproduced: foreign command lost from a mixed group; unrelated command containing marker misclassified and removed; valid JSON event object silently replaced; predictable temporary symlink redirected the write and the victim changed while write_atomic returned success. Logs `/tmp/oarlock-depth-r130-r131-probe.log` and `/tmp/oarlock-depth-r130-r131-extended.log`. No user config, product code or persistent tests changed. The tests do not prove a concurrency race or that an unsupported shape is accepted by a provider. Added R223 for the independently destructive unexpected-shape path; marker-collision evidence belongs to R130.

AP002 focused regression: **51 passed, 2 skipped in 5 files** (`/tmp/oarlock-depth-r130-ap002-tests.log`). Fish and PowerShell are not installed; no cmd/Windows/WSL, mounted UI or full-suite validation is newly claimed. No AP002 code was modified; existing R222 remains. AP004/AP005 record options and recommendations; stop for user decisions before any implementation. AP001/AP003 remain deferred and K001 remains log-only. Only this ledger changed in the repository; no commit or push.

### AP004/AP005 decisions (2026-10-28)

User selected preservation of foreign hook commands and group settings with refusal on ambiguous or unexpected configuration, and preservation of verified settings symlinks with safe publication. These are recorded policy decisions; the requested validation batch had a stop-before-code checkpoint. R130, R131 and R223 are still unresolved. No product or test code changed.

### AP004/AP005 implementation checkpoint (2026-10-28)

AP004: `agent.rs` now identifies exact generated or known historical commands, removes only those entries, preserves foreign entries and group metadata, and refuses ambiguous marker strings, unexpected shapes, or extra settings on an owned entry. New persistent merge tests cover mixed groups, metadata, ambiguous markers, unexpected shapes and historical migration; existing idempotence and old marker tests pass. The merge portion of R130 and R223 is fixed locally, but the actual installer currently cannot update an existing settings file because of AP005.

AP005: the deterministic `.oarlock-tmp` write was replaced with the shared private staging/handle-bound exclusive creation path, coordinated with the native per-file lock. Existing entries, including symlinks, are refused before replacement; already-correct settings remain a no-op. This prevents the demonstrated staging attack and lost updates on new-file publication, but is **not the full approved feature**: ordinary existing settings cannot be changed, and verified symlink targets cannot yet be updated. The shared writer explicitly lacks an atomic compare-and-replace against external programs. The approved policy requires failure rather than claiming that a final check plus rename is a guarantee. AP005 and R131 remain open as a usability/implementation limitation; Windows and other unsupported safe-write environments fail rather than overwrite. K001 remains log-only.

Added `agent_regression_tests.rs` and included it from `agent.rs`: five cases cover the pre-existing staging symlink, existing settings and symlink refusal, competing creates and unchanged unsupported JSON. Those exact test cases and production source passed **5/5** in a temporary copy of the full native project (`/tmp/oarlock-ap005-module-validation.log`); the workspace suite was not rerun after adding the test-module declaration. Before that declaration, the focused agent suite passed 20 tests; full native suite passed **1,543 tests, 3 ignored**, Clippy passed with warnings denied, frontend types/lint passed (80 existing lint warnings), and frontend suite passed **5,486 tests, 2 skipped**. Logs: `/tmp/oarlock-ap004-ap005-{tests,clippy,native,types,lint,frontend}.log`. No full Windows/Linux runtime or external-writer atomicity test was performed.

`agent.rs` received three edits in this continuation, the third solely adding the prevalidated test-module declaration. Per the user's checkpoint rule, stop now and report; no additional depth batch, commit or push. The previous user's worktree changes are preserved.

### AP005 continuation checkpoint (2026-10-28)

The user requested safe updates to existing agent settings and verified symlink targets, with approval before architecture changes. Investigated the existing handle-owned staged writer and OS behavior; no enforceable existing-file comparison/publication primitive was established on this macOS host. A two-process real-filesystem probe demonstrated that an exclusive advisory lock does not block a noncooperating write or pathname replacement. AP005's strict policy therefore remains unchanged: existing-file and symlink updates still fail safely. AP006 records alternatives and awaits user direction; no separate-file implementation or weaker guarantee was authorized.

Added two permanent Unix regression tests in `src-tauri/src/modules/agent_regression_tests.rs`: an independent process modifies the file while Oarlock's own lock is held, after which publication refuses to overwrite it; a hard-linked settings entry is refused with both names unchanged. These test the existing safe refusal, not a working existing-file update or a complete concurrent compare-and-swap. Focused native suite **7 passed** (`/tmp/oarlock-ap005-continuation-tests.log`); Clippy all targets with warnings denied passed (`/tmp/oarlock-ap005-continuation-clippy.log`). Lock probe: `/tmp/oarlock-ap005-lock-probe.log`. No product code, full frontend suite or other-platform runtime changed or rerun in this continuation. The feature-research Morph search failed due a connection error; local source and primary platform documentation were used instead. No new depth batch, commit or push.

### AP005 best-effort implementation checkpoint (2026-10-28)

After AP006 the user explicitly selected best-effort updates with the remaining external-overwrite race. Added `agent_settings.rs` and changed both JSON-hook and Pi installation to use a native per-target lock covering the read, merge and conditional publication. The snapshot includes file identity and content; the original parent and any symlink are revalidated before publication, the target symlink is preserved, and shared private staging carries forward ACLs and extended metadata where supported. Unexpected or ambiguous hook data still refuses the write. Concurrent Oarlock writers serialize.

This is **not atomic compare-and-swap against external processes**. A noncooperating application can still change a file after the final check and before rename, and a symlink or parent can change in that final window. The user explicitly accepted the remaining overwrite race; no stronger guarantee is claimed. Windows symlink identity and shared safe staging are unsupported and fail safely; K001 remains log-only. No live Windows/Linux runtime certification.

Regression coverage: successful existing JSON update preserves user fields; verified symlink update preserves the link; Pi symlink behavior; concurrent enables; external write during merge and same-content file replacement conflict; symlink, same-target symlink and parent retargeting during merge are refused; old staging-symlink victim and other hardlink remain unchanged; macOS quarantine metadata survives. These checks use a real filesystem and controlled interleavings, not the unprotected final race. Existing create-only helper tests are retained for their narrow staging checks and are not a claim that the production update path universally refuses existing files.

Verification was performed in an isolated copy of the current native project with the two final test assertion corrections and platform test guards: **36 focused agent tests passed**, full native suite **1,559 passed / 3 ignored**, and Clippy all targets with warnings denied passed. Frontend check-types and lint passed (80 existing warnings); full frontend suite **5,486 passed / 2 skipped**. Logs `/tmp/oarlock-ap005-best-effort-{final-scratch,full-native,clippy,types,lint,frontend}.log`. The full native suite ran before test-only platform guards were added; those guards do not alter the macOS test set, which was then rerun focused. The final workspace test assertions and test guards are byte-identical to the validated copy; no full workspace rerun after their application.

`agent.rs` and `agent_regression_tests.rs` each receive a third edit solely to apply prevalidated test corrections/guards. Per the user's edit-count checkpoint rule, stop immediately afterward; no new depth batch, commit or push.

### Depth checkpoint — R189/R027, AP005 regression (2026-10-28)

Validated in `/tmp/oarlock-depth-r189-r027/src-tauri`, a copied native project with three temporary tests appended only in the copy. A deterministic callback in the actual `asset_all_folders::respond` swapped the authorized file to a link to an outside fixture between authorization and open; the real response returned HTTP 200 and outside bytes. In a second controlled interleaving the actual `WorkspaceRegistry` gate authorized an entry, its parent was replaced with an outside-directory symlink, and actual `delete_path` deleted the outside fixture. A third used the same gate and `copy_item` to copy outside fixture bytes into the workspace. The three safety assertions intentionally failed (`/tmp/oarlock-depth-r189-r027-repro.log`). These are deterministic native-function/real-filesystem tests, not a mounted app or operating-system exploit test. Rename/move and other platforms were not independently reproduced. R027 is escalated from MAJOR to BLOCKER because the controlled test demonstrates out-of-root deletion; R189 remains BLOCKER.

AP005 regression: current workspace `cargo test --locked --lib modules::agent::` passed **36 tests** (`/tmp/oarlock-depth-r189-ap005.log`), including existing-file and symlink updates and the accepted best-effort conflict checks. That check does not remove AP006's user-accepted final external-write race or validate Windows/WSL. AP007/AP008 record architecture proposals and await the user's decisions. No product or persistent test code changed, no unrelated depth batch, commit or push. Only the ledger changed in the repository.

### AP007/AP008 decisions (2026-10-28)

User selected verified opened-file handles for preview authorization and serving, with safe refusal where verification is unavailable; and handle-bound filesystem mutation/copy ownership, with refusal where required entry identity cannot be enforced. These are recorded policy decisions. The validation-only batch stopped before code changes; R189 and R027 remain unresolved. No product or test code changed in this decision-recording step.

### AP007/AP008 implementation checkpoint (2026-10-28)

AP007 opens once, resolves the handle's path, matches it directly against current scope patterns and the app's all-folders setting, and serves from the same handle. Five new tests cover post-open file and parent swaps, symlink target authorization and dot names, a FIFO, and refusal/HEAD. The 12 focused preview tests pass on macOS. Scope-pattern races, pre-open swap interleavings, origin handling at the live protocol boundary, permission changes during a response, and Windows/Linux still need the approved test matrix. Scope matching is tied to the currently configured literal-leading-dot rule. No claim is made for Tauri's separate asset protocol.

AP008 has only the approved safe refusal, not the requested working native-handle operations. All Explorer rename/move/copy/delete requests are rejected before any filesystem work, including batch deletion; theme-file cleanup shares the rejected Delete command. UI error paths now explain the refusal. The focused guard test demonstrates that work behind the guard does not run, but does not exercise actual Tauri commands or the full proposed race matrix. Keep R027 open and do not ship the guard as if normal Explorer functionality were complete.

Checks: `bun run check-types` and `bun run lint` passed (lint emitted existing warnings); 16 targeted frontend tests passed; the 12 preview tests and one guard test passed; `cargo clippy --all-targets --locked -- -D warnings` passed. Full frontend: 5,485 passed, two failed while trying to bind localhost; full Rust library: 1,414 passed, 23 failed in unavailable localhost, macOS FSEvents, or restricted socket operations, three ignored. Other Rust test targets were not reached after library failure. The Rust formatting check reported formatting differences in the preview source/test; formatting had not yet been rechecked at this checkpoint. Linux, Windows and live-window tests were not run. No commit or push.

### AP008 continuation checkpoint (2026-10-28)

Restored production regular-file copy only on macOS when the source and destination filesystem support `fclonefileat`. It clones from the authorized open source into the authorized open directory, atomically and without replacing a destination; conflict renaming retains exclusive publication. It does not use a pathname-based staging publisher: that first approach was discarded after recognizing a final staging-entry replacement race. Folders, symbolic links, cross-volume copies, unsupported filesystems, Windows/Linux copies and all rename/move/delete operations continue to fail safely. The latter also leaves theme-file cleanup unavailable. R027 remains a release blocker, and this is not the complete AP008 implementation.

Eight real-filesystem focused tests in an isolated native project cover the production batch, unauthorized sources, source-parent and post-open source swaps, destination-parent replacement, final symlink conflict, unsupported folders/links and simultaneous copies. They do not exercise live Tauri IPC, multiwindow interactions, final-entry identity for unsupported destructive operations, or Windows/Linux. Older `copy.rs` unit tests exercise the now test-only legacy helpers, not the production copy boundary. The isolated project passed all-target Clippy with warnings denied; its full Rust library run passed 1,424, failed 23 due to denied local sockets or FSEvents, and ignored three (`/tmp/oarlock-ap008-scratch-full.log`). The eight focused tests passed. The 14 preview tests passed in the workspace, including pre-open file/parent swaps, changing the all-folders setting between requests and the origin decision helper; real protocol dispatch, direct scope-pattern change races, mid-response revocation and other-platform validation remain untested. Frontend type check and lint passed; 25 targeted Explorer/theme tests passed. No full frontend rerun in this continuation.

The final production and test files were prepared and validated in `/tmp/oarlock-ap008-scratch/src-tauri`; they are applied as the third edit to the copy source and tests, and formatting as the third edit to the preview test, so the edit-count rule requires an immediate checkpoint. No new architecture decision, commit or push.

### AP008 symbolic-link continuation checkpoint (2026-10-28)

On macOS, source acquisition now opens a symbolic link itself (`O_SYMLINK`); authorization checks the opened entry's path and the existing `fclonefileat` publisher clones that handle without following the target. The change retains the regular-file path and the no-replace destination guarantee. Tests exercise dangling, directory, and file links, including an outside target; replacing the link after authorization yields either the original link or a safe refusal, never the replacement. Folder copy remains refused. The local clonefile manual explicitly discourages recursive directory cloning; a single successful directory probe is insufficient to establish the required identity and symlink guarantees under concurrent mutation. Rename, move and delete remain refused because no conditional final-entry operation was established. Windows exposes handle-based rename/delete APIs, but no Windows target/runtime is available here and no unsupported implementation was enabled: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle . R027 remains a release blocker.

Verification: all ten focused native copy tests passed; all-target Rust Clippy with warnings denied passed; frontend type check and lint passed. Full native library: 1,426 passed, 23 failed in denied local-socket/FSEvents operations, three ignored (`/tmp/oarlock-ap008-links-native.log`); other native test targets were not reached. Full frontend: 5,485 passed, two failed because local HTTP servers could not bind, two skipped (`/tmp/oarlock-ap008-links-frontend.log`). No Linux/Windows runtime, live app, unsupported-volume, recursive mutation, multiwindow, or destructive-operation race tests ran. The focused tests ran before final test-only formatting. Formatting `copy_owned_tests.rs` is its third edit in this continuation, triggering the requested immediate checkpoint. No architecture change, commit or push.

### AP008 mutation feasibility checkpoint (2026-10-28)

No additional Explorer operation was enabled. Added two permanent Unix real-filesystem probes: after acquiring the original file and its parent directory, replacing the final entry makes macOS `renameatx_np` with `RENAME_EXCL` move the replacement, and makes parent-relative unlink remove the replacement. These tests prove why the proposed name-based primitives cannot enforce AP008's rule; they are not end-to-end Tauri command tests. The existing guard test and both probes pass, as do the ten existing copy tests and all-target Clippy with warnings denied. A separate scratch stress probe (`/tmp/oarlock-ap008-folder-race.py`) performed 100 atomic folder-clone attempts while swapping a directory and outside-pointing symlink 379 times: all 100 calls succeeded and no outside content was observed in copied real directories. That bounded sample is not proof of safe recursive identity or race handling, and no folder implementation was enabled. AP009 records the unresolved architecture question. Full suites were not rerun for test-only changes; prior environment-limited results remain documented above. No product source, commit, or push.

### AP009 decision and local safeguard check (2026-10-28)

The user chose to keep strict entry safety and avoid the macOS system extension. A new macOS real-filesystem regression probe checks the documented `unlinkat` `AT_NODELETEBUSY` flag: it refuses deletion while the selected original is open, but after replacing that pathname with a different closed file it successfully deletes the replacement. It is therefore not a conditional identity operation and is not enabled. The four focused guard/primitive tests and all-target Rust Clippy with warnings denied passed. Folder copy and destructive mutations remain unavailable, R027 remains a release blocker, and no product source was changed. Full suites were not rerun for this test-only change; earlier environment-limited results remain recorded above. No system extension, commit, or push.

### AP008 non-extension continuation checkpoint (2026-10-28)

No additional operation was enabled: the documented macOS name-based rename/unlink interfaces do not condition their action on a retained final-entry handle, and the earlier deterministic tests demonstrate the resulting replacement race. The directory clone primitive does not establish the required recursive-entry guarantees and Apple discourages its use on directory hierarchies. Apple's [filesystem snapshot manual](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/fs_snapshot_create.2) states that all snapshot operations require superuser privileges and an additional entitlement; no privileged snapshot design was requested or implemented. Windows handle APIs have not been validated on a Windows host. The approved strict policy and no-system-extension decision remain in force, and R027 stays a release blocker.

Added two production-copy-path regression tests: replacing a folder after it is opened cannot copy the replacement, and a folder containing a link outside the workspace leaves no partial copy. These verify the current refusal, not a functioning folder-copy implementation. The twelve focused copy tests, four guard/primitive tests, and all-target Rust Clippy with warnings denied passed on macOS. No live Tauri command, cross-platform, recursive-copy implementation, or full-suite test was run in this continuation; prior full-suite environment restrictions remain documented. No product source, new architecture, commit, or push.

### AP008 folder semantics investigation checkpoint (2026-10-28)

Investigated a potential handle-based macOS directory clone. Two new real-filesystem primitive tests pass: cloning from an open folder after its pathname is replaced copies the opened folder and preserves a nested symlink in the tested case; an existing destination symlink is not replaced or followed. These tests are evidence about the primitive on this host, not production IPC tests or proof of safe recursive behavior under all mutations. Additional local probes found that cloning a folder with an unreadable child failed without publishing a destination, and copying into its own descendant failed without publication. Apple's directory-clone documentation remains discouraging, the prior concurrent stress probe is not a proof of symlink and content consistency, and no folder-copy implementation was enabled. AP010 asks the user to select the required behavior for changes within a folder. All-target Rust Clippy with warnings denied and both focused primitive tests passed. Rename, move and delete remain refused; AP008 and R027 remain release blockers. No system extension, product source, commit, or push.

### AP010 decision and snapshot feasibility checkpoint (2026-10-28)

The user chose a consistent snapshot of a folder's contents. A scratch macOS stress probe (`/tmp/oarlock-clone-snapshot-probe.py`) made 2,000 folder clones while two source entries were atomically exchanged 207,727 times; it observed no output combination that could not have existed at one instant. This bounded result does not prove snapshot isolation or establish guarantees for other filesystems or mutation patterns. A new bounded permanent diagnostic checks the same invariant over 64 attempts with an independently running swap thread; the three primitive tests and all-target Clippy with warnings denied passed in `/tmp/oarlock-snapshot-validation/src-tauri`. The test confirms observed behavior on this host, not an API guarantee or a production folder-copy implementation. User-visible folder copy, rename, move and delete remain blocked, and R027 remains a release blocker.

The validated test-only file is copied from the isolated project as its third edit in this continuation; the user-requested edit-count rule requires stopping immediately afterward. No system extension, product source, commit, or push. Full suites and other-platform runtime tests were not run; prior environment-limited results remain documented above.

### AP008 snapshot and mutation continuation checkpoint (2026-10-28)

No additional Explorer operation was enabled. Two new macOS filesystem primitive tests confirm that, in the tested environment, cloning a folder with an unreadable child or into its own descendant fails without leaving a destination. They test the OS primitive, not a functioning production folder-copy path or snapshot isolation. Nine focused guard/primitive tests and all-target Rust Clippy with warnings denied passed in `/tmp/oarlock-ap008-failure-validation/src-tauri`; the twelve existing production-copy tests passed in the workspace. Full suites and non-macOS runtime tests were not rerun.

Investigated whether native filesystem-event monitoring could validate a direct folder clone. Apple documents a synchronous event flush and dropped-event reporting, but that alone does not solve publication: if a source change is detected after a direct clone appears at its destination, safely removing that entry encounters the same unresolved final-entry replacement race. A private staging design would also need an enforceable publication and cleanup boundary and proof of event coverage before it could meet AP008 and AP010; no such architecture is approved or implemented. Sources: [Apple FSEventStreamFlushSync](https://developer.apple.com/documentation/coreservices/1445629-fseventstreamflushsync), [Apple FSEvents guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html). R027 remains a release blocker. No system extension, product source, commit, or push.

The validated test-only file is copied from the isolated project as its third edit in this continuation, so the user-requested edit-count rule requires stopping immediately afterward.

### AP008 non-extension rename feasibility checkpoint (2026-10-29)

Investigated macOS `RENAME_SECLUDE`, an additional flag present in the platform headers. In a real-filesystem interleaving, after opening the selected file and replacing its directory entry, `renameatx_np` with this flag moved the replacement while the original handle still referred to the selected file. Combining this flag with `RENAME_EXCL` returned `ENOTSUP` on the test volume; no conclusion is drawn for other filesystems. A new permanent macOS primitive regression test covers the first case and safely accepts an unsupported-filesystem error. It demonstrates why the flag is not an implementation of the approved source-identity guarantee; it does not call the guarded Tauri command.

The ten focused guard and filesystem-primitive tests and all-target Rust Clippy with warnings denied passed in `/tmp/oarlock-ap008-seclude-validation/src-tauri`. Folder copy, rename, move and delete remain unavailable; AP008 and R027 remain release blockers. The earlier user decisions requiring a consistent snapshot, exact entry identity and no system extension were not weakened. Full suites and Windows/Linux runtime tests were not run in this continuation. No product source, new architecture, commit or push.

The validated test-only file is copied from the isolated project as its third edit in this continuation, triggering the user's immediate checkpoint rule.

### AP008 Apple platform evidence checkpoint (2026-10-29)

Apple Developer Technical Support responded to a question about a same-user process replacing a source directory entry between verification and hard-link or rename publication. The engineer states that macOS currently lacks a supported public API to create the requested hard link directly from the open descriptor, and that pathname-based link/rename publication cannot guarantee the source is the previously validated object against this substitution. The response discusses post-operation detection and Endpoint Security; neither changes the user's approved prevent-before-mutation policy or their decision against a system extension. Source: [Apple Developer Forums, DTS response](https://developer.apple.com/forums/thread/850377). The response is evidence about the specific hard-link/rename publication threat; it does not independently prove the behavior of every deletion, destination-movement, folder-clone, filesystem, or operating-system version.

This strengthens the existing controlled rename-replacement evidence but does not supply an enforceable implementation. Folder copy, rename, move, delete, and the temporarily guarded copy path remain unavailable. AP008 and R027 remain release blockers; R224 remains mitigated by refusal. The user was asked whether to keep researching AP008 or move to another depth-phase blocker while retaining AP008 as a release blocker. No code, new test, system extension, privileged service, architecture change, commit, or push was added. Existing regression and validation results are recorded in preceding checkpoints; they were not rerun for this evidence-only update.

### AP008 Windows feasibility checkpoint (2026-10-29)

Investigated the remaining operations on Windows without changing product code. Microsoft documents opening an entry itself with `FILE_FLAG_OPEN_REPARSE_POINT`, controlling delete/rename sharing, and `SetFileInformationByHandle` with `FILE_RENAME_INFO`; the latter describes a destination directory handle and no-replace mode. Handle-based disposition is also documented. These are possible building blocks, not a verified implementation. In particular, destination-handle behavior, source and parent replacement, reparse points, hard links, replacement conflicts, open-handle deletion semantics, recursive partial failure, cross-volume cases, WSL/SMB and mutation events require real Windows tests. Do not enable an implementation solely from these documents. Sources: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info), [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).

The current host has only the macOS Rust target and the checked-in Rust CI matrix covers Linux and macOS, not Windows. A network attempt to query the Rust distribution service failed DNS resolution; no target was installed. The user was asked whether a Windows test machine or runner can be provided. No system extension, new architecture, production implementation, regression test, commit, or push was added in this investigation. AP008 and R027 remain release blockers, with macOS folder copy, rename, move and delete still refused under the existing decisions.

### AP008 platform priority (2026-10-29)

The user clarified that no Windows runner is currently available: macOS is the main focus, with some Linux support, and the remaining Linux work and the Windows port follow completion of the feature set. Do not make a Windows runner a prerequisite for further macOS work or assume Windows APIs resolve the macOS blocker. The previously approved consistent-snapshot and exact-entry-identity requirements, and the decision against a system extension, remain unchanged. No product source, architecture, test, commit, or push changed in this decision-recording step.

### AP008 moved destination interleaving (2026-10-29)

In `/tmp/oarlock-ap008-dest-race/src-tauri`, a controlled test opened a source and an authorized destination directory, ran the actual `CopyContext::validate`, moved that exact directory outside the authorized root, and called the actual `publish` with its retained handle. A second test invoked the actual `copy_batch` and used a test-only hook to move the directory immediately after its last check; publication succeeded in the relocated directory and the batch reported success at the stale original path. The safety assertions failed as intended. This reproduces the production function's unprotected interleaving, not a live app invocation. It does not show a redirected handle or establish which authorization lifetime the user intends. Logged R224 and AP011, and asked for that architecture decision before changing code. No product source or permanent test changed; existing copy remains enabled pending the decision. No commit or push. This is the third ledger edit in this continuation, so the user's edit-count rule requires an immediate checkpoint.

### AP011 decision and safe-refusal checkpoint (2026-10-29)

The user selected continuous location authorization. `fs_copy` now refuses immediately, and its native `copy_batch` entry point independently refuses before opening or modifying files. Two new tests exercise that guarded batch on an ordinary destination and on a destination moved outside and replaced with a symlink; neither creates a file. Earlier helper tests now explicitly exercise the dormant internal implementation and are not evidence that copying is enabled. This is a temporary mitigation, not a working location-bound implementation or a resolution of the AP008 release blocker. Folder copy, rename, move and delete also remain unavailable.

Verification: fourteen focused native copy tests, thirty-one targeted Explorer frontend tests, Rust all-target Clippy with warnings denied, frontend type check and lint passed. Full frontend: 5,485 passed, two failed while local HTTP servers could not bind, two skipped (`/tmp/oarlock-ap011-frontend.log`). Full Rust library: 1,439 passed, 23 failed in denied local-socket or unavailable macOS FSEvents operations, three ignored; later native targets were not reached (`/tmp/oarlock-ap011-native.log`). No live Tauri IPC, Windows/Linux runtime, or full release verification was performed. No system extension, further architecture, commit, or push.

### R054 depth validation; AP008 deferred (2026-10-29)

Following Apple's developer-support response that the required macOS pathname protection is not provided by a supported public API, the user chose to continue with another blocker. AP008/R027 remains an open release blocker under the existing strict safety and no-system-extension decisions; the affected Explorer actions remain refused. The Apple response is recorded as reported in the prior investigation, not independently verified in this batch.

R054 remains an open release blocker. The helper's capability response reports `executionReady: false`, while native commit calls the live Git runner instead of candidate execution. Two focused native integration tests added only in `/tmp/oarlock-r054-validation/src-tauri/tests/git_operations.rs` passed: `r054_live_commit_executes_executable_hook` observed a harmless fixture hook run and the commit succeed; `r054_live_commit_changes_replaced_repository_before_detecting_it` paused that hook, replaced the fixture's `.git` with a symlink to another disposable repository, and observed that repository's branch advance before the operation returned an ownership error. These invoke the real Rust operations with disposable repositories; they do not exercise a packaged Tauri/XPC app or other platforms. No production code or permanent tests were changed. The already-approved isolated Git execution and safe publication work is incomplete; the tests document present behavior and must not be mistaken for tests of the desired safety policy.

### R054 partial implementation and AP012 (2026-10-29)

Added a dependency-light object identity building block that derives the Git SHA-1 object ID and SHA-256 content identity from separately authorized bytes and checks returned candidate bytes and object kind against that identity, subject to a caller-supplied size limit. It is not wired into live Source Control or the XPC service, does not establish source authorization or object-graph validity, and does not publish objects. Three unit tests cover real Git's blob ID, mismatched bytes and kinds, and size limits; a real-Git index test checks that a separately captured blob ID can validate the corresponding index entry and that a different authorized ID is rejected. This is partial work, not the requested isolated executor, a fix for R054, or a passing regression for the hook/repository-swap failures.

New R225: a test-only hook in `/tmp/oarlock-r054-validation/src-tauri/src/modules/git/index_publication.rs` moved the fixture repository outside its authorized root after the existing publisher's final ownership check and just before its directory-relative index rename. The actual publisher committed the new index at the moved location, then returned `repository_still_current: false`. This is an injected native interleaving, not a live Tauri test, and affects the dormant index publisher rather than an already enabled isolated action. The original approved Git design treats retained handles as publication authority; the later AP011 decision required continuous location authorization for Explorer copy. These choices need reconciliation before connecting the publisher.

AP012 options: (1) require continuous location authorization for Git publication too, as with AP011, and refuse publication until a supported enforcement mechanism exists; (2) authorization follows the retained repository identities for the operation, with explicit reporting when they move. Recommendation: option 1 for consistent workspace authorization. The existing pre/post path checks cannot enforce option 1. No change to publication policy or new executor wiring was made pending the user's decision.

Validation: the three new unit tests and one real-Git index integration test pass; 168 focused native Git tests pass; all-target Rust Clippy with warnings denied, frontend types and lint pass (lint reports 80 existing warnings). The full frontend run had 5,485 passes, two failures and two skips; failures occur starting sandbox-denied local HTTP servers. The full Rust run had 1,443 passes, 23 failures and three ignores in the library target; failures include sandbox-denied local sockets, FSEvents and a filesystem operation, so later targets were not reached. Logs: `/tmp/oarlock-r054-{git-tests,clippy-final,frontend,native}.log`. No live packaged-XPC test, macOS signing verification, Linux/Windows runtime test, commit, or push. R054 and AP008 remain release blockers.

### AP012 decision and R054 continuation (2026-10-29)

The user chose authorization following the opened repository for Git publication. This is deliberately distinct from AP011's continuous-location rule for Explorer copies. A new test-only final-rename hook exercises the real index publisher as its repository moves and a different repository entry appears at the old location. The publisher updates only the held repository and returns a committed outcome with `repository_still_current: false`; it leaves the replacement untouched. All 17 focused index-publication tests and all-target Rust Clippy with warnings denied pass. The publisher may still refuse a move detected earlier during preparation, and remains disconnected from live Source Control.

This is not a fix for R054: candidate execution, coherent capture, executable-extension admission, verified object publication, operation-specific journaled index/ref/worktree publication, and XPC integration are still incomplete. Source Control continues to use the unsafe live Git path. No packaged-XPC runtime test, full-suite rerun, commit or push was performed in this continuation; the prior full-suite sandbox limitations remain recorded above. AP008/R027 is also still a release blocker.

### Threat model and coverage checkpoint (2026-10-29)

**Recommendation for user decision, not a change to the approved guarantees:**

- **Ordinary concurrency and failure:** the user, another window, an editor, Git or the OS can make changes at inconvenient times without hostile intent. Guarantee no silent data loss, clear conflict/refusal reporting, and recovery evidence where cooperating operations or enforceable native primitives support those guarantees; document residual races with external programs that bypass them. Platform capability and release-asset gaps remain explicit limitations.
- **Untrusted repository content/configuration:** a repository can contain misleading paths, symlinks, attributes, Git config and executable hooks or helpers. Guarantee Oarlock's own actions do not automatically execute repository-controlled programs or escape workspace permissions. Explicitly running commands in the terminal remains a user-authorized action, not a claim that the terminal is sandboxed.
- **Misbehaving restricted component:** an MCP server or agent operating through restricted interfaces, or the sandboxed Git helper, may return hostile data or stall. Guarantee the stated interface and sandbox boundaries, validate results, and bound resources/cancellation. A freely launched user terminal process is not covered by that restricted-component guarantee.
- **Hostile local process with the user's privileges:** such a process can generally access the same user files directly and can race Oarlock's path/config checks. Recommend best effort with documented residual races for interactions with noncooperating programs, rather than claiming machine-wide atomicity; preserve strong protection against replacement where native handles/atomic APIs enforce it. This is a proposed general policy, not an authorization to weaken AP008, AP011 or R054a; AP005's accepted race is a specific precedent. A different security boundary would be needed to guarantee protection from same-user processes.

**Open blocker mapping:** AP008/R027 (Explorer operations refused) and R224 (copy remains refused) are driven by ordinary concurrent changes or a hostile same-user path mover; the original R027 escape also involves untrusted filesystem entries. R054a involves untrusted repository configuration; a preflight bypass also involves concurrent/hostile configuration changes. R054b involves concurrent/hostile metadata replacement. R225 is resolved by the Git-specific AP012 policy, not an open blocker. Other open or conservatively retained blockers: K001 and R026 (platform/safe-write capability, no attacker); R019 (Windows restore capability, no attacker); R111 (missing release hashes, no attacker); R005 (custom/replaying control client or accidental ID reuse, not reproduced live); R136 (stalled or misbehaving MCP server); R169 (ordinary concurrent editing, AI work remains on hold); R189 (untrusted filesystem entries/concurrent replacement, fixed on tested macOS path but other platforms and scopes remain unverified). K001 and R026 overlap in cause.

Coverage remains **35 DONE / 0 TODO sections**, including F1–F5, and **1,751 listed files reviewed** in the breadth sense, not exhaustively certified. Outside AP008/R027/R224 and R054, the conservative ledger count is **8 open or not fully validated BLOCKER entries and 166 MAJOR entries**. This counts K001 and R026 separately, keeps R189 for its unverified residual scope, excludes R084/R086 and AP004/AP005's locally fixed R130/R131/R223, and treats the other breadth findings as still open without revalidating each one. AI-related entries remain on hold. These are finding counts, not independent root causes or newly reproduced bugs.

### R054a refusal investigation and R054b plan (2026-10-29)

**R054a remains open; no production mitigation was enabled.** The normal native commit currently runs repository hooks and an executable `core.fsmonitor`. Two permanent pending regressions in `src-tauri/tests/git_executable_refusal.rs` call the real native commit; when deliberately run with `--ignored`, both fail on the current implementation because the program executed. They are ignored in ordinary runs until a fix exists; passing an ignored suite is not a fix. A separate real-Git probe with `core.hooksPath=/dev/null` still executed Git 2.56's named configured `hook.<name>.command`/`.event`, and a filesystem monitor also ran. The repo-provided execution surfaces requiring admission include filesystem and named hooks, `core.hooksPath`, executable fsmonitor, clean/smudge/process filters, merge and diff/textconv drivers, signing programs, credential/authentication helpers, configured trailer commands, and lazy-fetch/external helpers; only the hook and fsmonitor execution on this commit path was reproduced here. The existing candidate policy fails closed on unfamiliar config, but is not connected to live commit.

The simplest overrides can silently skip an extension instead of refusing the operation, and inspecting mutable config before launch does not guarantee refusal if another process changes it afterward. No config-only method was established that enforces the requested unconditional policy for all supported Git versions and surfaces. Per the user's instruction, stop rather than build the isolated executor or claim a preflight alone is correct. A platform-enforced execution boundary or another independently proven enforcement mechanism remains necessary for the strict guarantee; a best-effort preflight would require the user's explicit decision. R054b remains untouched.

**R054b rough plan** (order-of-magnitude estimates for one experienced engineer, macOS first, including tests; uncertain and not delivery commitments): (1) authenticated bounded XPC operation/cancellation and private candidate execution, 1–3 weeks; (2) coherent capture, object verification and durable object publication, 1–3 weeks; (3) operation-specific native commit/ref/index publication, locks, recovery and crash tests, 2–5 weeks; (4) discard/branch/worktree and remote operations plus their journals and recovery, 3–8 weeks. Some work overlaps and large-repository/platform validation may add time. The existing candidate config policy, object identity helper, index planner and single-index publisher are reusable pieces, not complete execution permits.

The least work to prevent the reproduced swap from causing a native write is to refuse affected native mutations until a safe path exists; that changes availability and was not authorized or implemented here. To keep commit usable, a minimal safe commit needs isolated execution **and** validated durable objects plus native ref/index publication and recovery; the executor alone does not close the swap race. Stage, discard, checkout and other mutations each need their own publication guarantees. Terminal Git remains separate.

Checks: focused native Git suite **169 passed**; all-target Clippy with warnings denied, frontend types and lint passed (80 existing lint warnings). Both pending R054a tests failed as intended when explicitly run; the normal test target reports them ignored. Logs `/tmp/oarlock-r054a-{regressions,pending,git,clippy,types,lint}.log`. No production code, full-suite rerun, packaged-XPC test, commit or push in this batch.

### General threat-model decision (2026-10-29)

The user accepted the proposed general policy: protect against untrusted repositories and misbehaving restricted components, and treat races with other same-user programs as best effort where enforcement is unavailable. This general decision does not override the existing stricter, separately approved Explorer and Git decisions, including AP008, AP011, AP012 and the R054a refusal policy. Any relaxation of those decisions requires a separate user decision. R054a, R054b and AP008 remain open; the two R054a regression tests remain ignored until a correct fix is implemented. No production or test code changed in recording this decision.

### R054a implementation under the approved best-effort race policy (2026-10-29)

The user explicitly accepted the same-user config-change race for R054a. Source Control commit now checks effective Git configuration, repository and worktree scopes, repo-origin included configuration, and the common hooks directory before invoking commit. It refuses hooks and configured executable classes with a named category and terminal guidance; executable sample templates are ignored because Git does not invoke them. It checks configured hook paths and named hooks, fsmonitor, filter/diff/merge drivers, repository credential and SSH/authentication helpers, signing, editors, trailer commands, object hooks and remote-helper/partial-clone settings. The inspection is bounded and fails closed on incomplete or unreadable config. Ordinary global credential helpers do not by themselves block all local commits; globally configured hooks, filters and other classes that repository content could activate are checked. Invocation overrides suppress common hook events, fsmonitor, signing, authentication helpers and other known paths as defense in depth. Static refusal occurs before those overrides; extensions are not silently skipped as an accepted normal commit.

**Residual risk:** another same-user process can change configuration, hooks or repository metadata after inspection. Invocation overrides reduce but do not eliminate that race, and Git versions differ. The user accepted this R054a race as best effort, like AP005. This commit guard does not apply to Stage, Discard, other Git actions or terminal Git; R054b's previously reproduced repository-swap race remains open under its separate strict decision. A real-Git temporary fixture also confirmed a static clean filter executes during `git add`; the Oarlock Stage path was source-checked to invoke Git add, but a live Tauri test was not performed. No R054b reclassification or fix is applied.

The two earlier ignored hook/fsmonitor regressions are enabled. A real-Git integration matrix covers the executable config classes, included config, an includeIf file inside the repository, executable and symlinked hook directories, and a successful commit with Git's non-executable sample templates. A native test injects hook and fsmonitor settings after preflight to exercise invocation-level defenses. Validation in a disposable copy of the final source: **8 refusal tests, 61 existing Git integration tests, and 170 focused native Git tests passed**; all-target Clippy with warnings denied, frontend type checks and lint passed (80 existing lint warnings). No Windows/Linux runtime, packaged-app or full-suite verification. Test logs: `/tmp/oarlock-r054a-final4-refusal.log`, `/tmp/oarlock-r054a-final3-{integration,git}.log`, `/tmp/oarlock-r054a-final4-clippy.log`, `/tmp/oarlock-r054a-new-{types,lint}.log`. R054a is addressed under the newly selected best-effort policy; this is not isolated execution.

### Proposed blocker reclassification — no decisions applied (2026-10-29)

The user must approve or reject each row. “Best effort” below applies only to races caused by other same-user programs; static hostile repository content, restricted components, and cooperating Oarlock operations retain their guarantees. Proposed changes are not implemented. Conditional release-scope changes require a separate product-scope decision.

| Row | Actor or condition | Model | Proposal and consequence if approved |
| --- | --- | --- | --- |
| AP008 | Another same-user program changes selected entries or folder contents during a mutation; ordinary concurrent edits can have the same effect. | Best effort for that external race; static malicious entries remain protected. | Propose superseding the strict final-entry and single-snapshot requirements in AP008/AP010 for noncooperating external changes, retaining checks, explicit conflicts where detectable and documented residual races. This could permit a later tested implementation of folder copy, rename, move and delete; it does not re-enable them by itself. |
| R027 | Static malicious entries plus a separate process replacing validated paths during an operation. | Static entries guaranteed; external replacement best effort. | Propose reclassifying only the external replacement race after safe static-entry checks, explicit outcomes and regression tests are implemented. The original outside-workspace mutation must not become allowed merely because a repository contains a symlink. |
| R224 | A same-user program moves the already-open destination after its location check. | Best effort for external movement. | Propose superseding AP011's continuous-location rule and letting authorization follow the originally opened destination, with an accurate moved-location outcome. The operation could then write to that same directory after it moves outside the workspace. No copy is enabled yet. |
| R054b | A same-user program replaces repository metadata during a live Git operation; static repository config can also cause Git to execute helpers. | Swap race best effort under the proposed relaxation; static repository content remains a guaranteed boundary. | Propose superseding the strict swap-race requirement only, documenting possible writes to a replacement repository. This may defer the isolated executor for that race, but cannot by itself clear executable-extension risks in Stage or other Git operations. R054b stays a blocker until those independent risks and any release-scope decision are addressed. |
| K001 | Unsupported Windows safe-write capability. | Platform functionality, not attacker-dependent. | Keep log-only and unresolved for Windows, as previously directed; no threat-based downgrade. |
| R005 | A custom/replaying control client reuses a request ID; late replies can satisfy a newer request. | Restricted interface / request ownership guaranteed. | Keep blocker pending validation and AP001 decision. |
| R019 | Windows saved-window restoration is unsupported. | Platform functionality, not attacker-dependent. | Keep unresolved for Windows; consider release-scope downgrade only if Windows is explicitly excluded from this release. |
| R026 | Safe writes unsupported on Windows and some Unix volume/filesystem arrangements. | Platform functionality and ordinary user data, not attacker-dependent. | Keep blocker pending platform/scope validation; no automatic downgrade. |
| R111 | Missing Nix release hashes. | Distribution functionality, not attacker-dependent. | Keep unresolved for Nix; consider release-scope downgrade only if Nix is explicitly excluded. |
| R136 | A stalled/misbehaving MCP server can prevent its own termination. | Restricted component boundary guaranteed. | Keep blocker while MCP is in scope; AI-related work remains on hold. |
| R169 | An AI edit overwrites changes made after review, including ordinary in-app editing. | Ordinary user data and restricted AI surface guaranteed. | Keep blocker; do not downgrade as a same-user race. AI work remains on hold. |
| R189 | Malicious filesystem entries or changes during preview reads. | Untrusted entries guaranteed; other-process final races best effort. | Keep the macOS handle fix and unresolved platform/protocol validation; do not downgrade the untrusted-entry boundary solely because external races are best effort. |

### Proposed MAJOR triage — counts only, no reclassification (2026-10-29)

One primary group per finding, based on the existing ledger descriptions; these are planning groupings, not fresh validation. Counts total **166**, including AI findings that remain on hold. Trust and authorization: **15**; resource limits and process lifetime: **38**; operation ownership, ordering and cancellation: **56**; persistence, external change and durability: **21**; failure reporting and recovery: **6**; compatibility, data semantics and UI behavior: **30**. A finding can have secondary causes outside its assigned group.

**Same-user-race-only candidates: 0 confirmed; 4 conditional candidates for later validation** (R029, R033, R147 and R211). Consider downgrade only if their harmful interleaving requires an independent noncooperating same-user process; retain severity if a static untrusted repository, a restricted component, another Oarlock window or ordinary in-app user work can cause it. R147 is AI-related and remains on hold. No finding is downgraded by this proposal.

### Applied threat-model classifications (2026-10-29)

The user approved best effort for races requiring a separate same-user process, retained guarantees for untrusted repositories and restricted components, and directed mixed rows to be split. This table supersedes the earlier proposal; historic finding rows remain as evidence and are not additional active findings. Explorer operations remain disabled until separately restored and tested.

| Original row | Class and decision | What it unblocks |
| --- | --- | --- |
| AP008 → R232 / R233 | R232: external same-user mutation race, **best effort**. R233: static malicious entries and cooperating Oarlock work, **guaranteed / release blocker until safe functionality exists**. | Supersedes AP008/AP010's strict protection against noncooperating external races and permits later work to restore Explorer operations. |
| R027 → R226 / R227 | R226: external path replacement race, **best effort**. R227: static malicious entries, **guaranteed / release blocker until validated**. | Permits checked best-effort implementation without allowing static symlink escapes. |
| R224 | External destination move, **best effort**. | Supersedes AP011's continuous-location guarantee; a checked operation may race a move outside the workspace. Copy is not yet re-enabled. |
| R054b → R228 / R229 | R228: external repository-metadata swap, **best effort**. R229: executable content/config from an untrusted repository, **guaranteed / release blocker until all relevant paths are protected**. | The isolated executor is no longer mandatory solely for the same-user swap race. R229 covers Stage, status, diff, checkout, remote operations, discovery/history/worktrees and skill clone. |
| R189 → R230 / R231 | R230: external replacement race, **best effort**. R231: static untrusted-entry boundary, **guaranteed**, with macOS fixed and other platform/scope validation outstanding. | No rollback of the existing verified-handle preview fix; remaining validation stays open. |
| R005 | Restricted control-interface identity, **guaranteed / unchanged**. | Nothing; the ownership/replay issue remains open. |
| R136 | Misbehaving restricted MCP component, **guaranteed / unchanged**. | Nothing; AI/MCP work remains on hold. |
| R169 | Restricted AI write and ordinary in-app edits, **guaranteed / unchanged**. | Nothing; AI work remains on hold. |
| K001 | **Unchanged / cannot classify by attacker:** Windows theme writes fail because safe-write capability is unavailable, not because of a racing attacker. | Remains log-only as previously directed. |
| R019 | **Unchanged / cannot classify by attacker:** Windows restoration is unsupported rather than attacker-dependent. | No release-scope change inferred. |
| R026 | **Unchanged / cannot classify by attacker:** safe writes fail on some platforms or filesystems without an attacker. | No downgrade or platform implementation inferred. |
| R111 | **Unchanged / cannot classify by attacker:** Nix release hashes are missing independently of an attacker. | No distribution-scope change inferred. |

The former Git follow-the-opened-handle requirement is superseded where it conflicts with this rule; it remains a useful implementation safeguard, not a promised outcome during an external race. R225's AP012 test describes existing behavior and does not impose that guarantee. Existing R029/R033/R147/R211 MAJOR candidates remain unchanged until their actor classes are validated; R147 remains on hold.

**Explorer restoration plan, not implemented:** keep static workspace/environment authorization, secret-path checks, symlink entry semantics, existing mutation events, buffer protections and metadata safeguards. Add checked best-effort copy, folder copy, rename, move and delete with clear partial-failure handling; document that a noncooperating same-user process can replace/move entries or change folder contents after checks and that folder copies need not be a single snapshot under that race. Replace the current unconditional-refusal tests with successful ordinary-operation tests; retain static outside-workspace/symlink denial tests and add controlled external-interleaving tests that document conflicts or residual races rather than asserting impossible guarantees. No Explorer code or tests change in this batch.

**Git entry-point inventory:** repository resolution and panel snapshots; status; working/staged diff and content; editor file base; stage, unstage and coordinated discard; commit and undo; remote containment, fetch, pull and push; history, commit previews/files and file diffs; remote URLs and branch lists; checkout; worktree add/remove and linked-worktree status. `discover_repos` walks directories without launching Git. Internal configuration reads and bounded `rev-parse` discovery are bootstrap operations; availability/version probing is repository-independent. Skill installation's Git clone is explicitly included by the user's later answer, with checkout delayed until after inspection. WSL read-only Git keeps best-effort checks; WSL mutations remain unavailable. Local remotes require separate authorization and inspection before remote actions. These implementation items are in progress; no claim that R229 is complete is made by the inventory alone.

### Git entry-point implementation checkpoint (2026-10-29)

Repository admission now runs the executable-config and hooks preflight for the identified native Git entry points, with invocation-level defenses on subsequent Git calls. The Stage clean-filter regression failed on the previous implementation and passes now. The entry-point suite exercises resolution, panel/status, diffs and file base, stage/unstage/discard, commit/undo, remote containment, push/fetch/pull, history and previews, remote URLs, branches and checkout; separate native tests cover worktree add/remove. The shared gate also covers the AI staged-Git-diff entry point without otherwise reviewing the AI backend. `discover_repos` itself performs only filesystem walking. Raw version/config checks and bounded discovery are bootstrap calls; terminal Git is unchanged.

The user additionally chose to include skill installation: it clones without checkout, then inspects the staged repository and checks it out only if allowed. Tests cover refused smudge filters, a clean checkout, and the clone path through a local Git wrapper; an actual HTTPS/SSH clone was not tested. The user chose to keep WSL reads with best-effort checks; WSL mutations remain unavailable, and no Windows/WSL runtime was available for verification. For local-path and `file:` remotes, fetch/pull/push inspect Git-expanded remote URLs, require separate existing workspace authorization, then inspect the local destination. All configured remotes are checked, so an unrelated unauthorized or unsafe local remote can also block an operation. Unknown external transports and relevant remote commands are refused; ordinary trusted global network authentication helpers remain usable.

The earlier strict external-process race policies were explicitly superseded for Explorer and Git as described in the classification table. Same-user changes after preflight remain best effort; static untrusted repository content and restricted-component boundaries remain guaranteed requirements. R229's implementation is in place on the tested macOS path, but its release-blocker status remains open pending Windows/WSL and broader security-boundary validation; the isolated Git worker itself is not complete. Explorer copy, rename, move and delete remain refused and were not changed.

Verification: in a disposable copy, full native `cargo test --locked` passed **1,643 tests, 3 ignored**, and the full frontend suite passed **5,487 tests, 2 skipped** with system access; Clippy all targets with warnings denied, frontend types and lint passed (80 existing warnings). The copied final files were byte-compared to the tested sources; the workspace's 32-case entry-point suite also passed after application. Earlier restricted runs failed 23 native and 2 frontend tests because local sockets, FSEvents or a filesystem operation were denied by the sandbox. A 20-sample empty-fixture status check measured 25 ms median and 32.6 ms maximum on this Mac; no baseline or large-repository benchmark is claimed. Logs: `/tmp/oarlock-allgit-full-native-unrestricted.log`, `/tmp/oarlock-allgit-full-frontend-unrestricted.log`, `/tmp/oarlock-allgit-final-clippy3.log`, `/tmp/oarlock-allgit-workspace-matrix.log`, `/tmp/oarlock-allgit-status-timing.log`. No packaged-app test, Windows/Linux/WSL runtime test, commit or push.


## Windows port

Windows is outside the current macOS-first release; these entries are retained for the later port.

| ID | Severity | Section | Finding | Disposition |
| --- | --- | --- | --- | --- |
| K001 | WINDOWS PORT | F4 / 10 | Windows custom theme migration/saves are blocked by the existing safe-write implementation. | Windows-only, moved to the Windows port; not a blocker for the macOS-first release. Remains log-only. |
| R019 | WINDOWS PORT | 08 | Saved-window restoration requires adoption when the saved registry has no main window, but `windows/restore.rs::prepare` explicitly refuses every platform except macOS/Linux. Closing the original window, then quitting a remaining window, can leave Windows unable to restore that saved layout on its next launch. | Windows-only, moved to the Windows port; not a blocker for the macOS-first release. State remains retained. |
| R026-W | WINDOWS PORT | 10 | The native safe-write implementation does not support Windows staging and ACL preservation. | Deferred to the Windows port; distinct Unix limitations remain R026-U. |
| R035 | WINDOWS PORT | 12 | New-file authorization can finish after switching between WSL environments and create the file in the wrong distribution. | Deferred with WSL support to the Windows port. |
| R202 | WINDOWS PORT | F4 | Theme-file ingestion can use the current WSL environment instead of the environment that wrote the file. | Deferred with WSL support to the Windows port. |

## Explorer restoration and Git remote checkpoint (2026-10-29)

**Release scope:** macOS, with Linux where practical. Windows and AI-on-hold findings are excluded from the release-blocker count. Breadth coverage remains 35 DONE / 0 TODO. Conservatively **5 open release BLOCKER findings**: R005 (control request identity), R026-U (Unix safe writes on other filesystems), R111 (Nix release hashes), R229 (untrusted Git execution and remote-boundary coverage), and R231 (preview boundary: macOS handle tests pass, but packaged runtime/scope validation is outstanding). R136 and R169 remain open but are AI/MCP-on-hold; Windows entries are above. R229 includes the new remote-selection regression described below, not a sixth independent blocker.

**Explorer:** R226/R232 and R224 are accepted best-effort races. macOS file and folder copy, rename, move and delete are enabled. Linux rename/move/delete use the same entry checks; Linux copy remains unavailable because metadata preservation has not been validated. The checked copy path preserves ACLs and extended attributes, stages outside worktrees in a private same-filesystem location, refuses setuid/setgid entries macOS cannot preserve, checks nested symlinks and publishes without replacement. It rejects unverified/dangling nested symlinks and refuses when suitable staging is unavailable. Existing mutation events, conflict handling and buffer protections remain. Static outside-workspace symlink coverage for R227/R233 is retained; macOS focused tests pass, but packaged-app and Linux runtime testing remain outstanding. Concurrent changes by a separate same-user program after checks can still redirect a mutation, move a destination, or produce mixed-version folder copies. These races are documented best effort, not a defense against static untrusted entries.

**Nix R111:** GitHub returned 404 for v0.1.0 and an empty release list; final signed release assets do not yet exist. Generate the three hashes from the final `.deb` and signed `.app.tar.gz` release assets and validate the Nix install after they exist; no placeholder hashes were invented.

**R234, BLOCKER — experimental selected-remote guard:** A real local Git test in `/tmp/oarlock-explorer-batch` created an authorized repository whose path was the first line of another, unauthorized repository's path. A newline inside the configured local remote caused the proposed `remote get-url` parsing to authorize the first path and then actually fetch the unauthorized second path. The test failed with `unauthorized remote was used: Ok(())` (`/tmp/oarlock-remote-newline-probe.log`). This is part of R229's untrusted-repository boundary. The remote-selection edits and their six passing ordinary regressions are **not included in the Explorer checkpoint commit** and remain in the worktree in an unsafe, experimental state. Do not ship or use that worktree for Git remote operations until corrected. The next batch should use unambiguous value framing or refuse ambiguous control characters before executing Git, test fetch and push plus URL rewrites and multiple configured URLs, and rerun native checks. The file reached the two-edit tripwire in this batch, so no further edits were made to it.

**Validation:** On the combined worktree, full native `cargo test --locked` and Clippy all targets passed; frontend types and lint passed (80 existing warnings), and the unrestricted frontend suite passed 5,487 tests with 2 skipped. Focused macOS copy and static-escape tests passed; the targeted malicious-newline probe failed as described above and is deliberately not included in the safe Explorer commit. No packaged-app or Linux/Windows runtime testing was performed. Local baseline checkpoint `858b340`; no push.

## Remote URL framing checkpoint (2026-10-29)

R234's newline bypass is fixed on the tested macOS path. Testing the exact original reproduction against commit `858b340` initially refused it because the second line did not resolve to an authorized repository. A stronger variant made both newline-separated fragments resolve to authorized repositories; the committed all-remotes implementation then fetched the unauthorized combined path and the regression failed. This is a confirmed vulnerability in `858b340`, not solely in the later narrowed implementation.

The narrowed remote check now reads selected remote URLs and applicable rewrite settings with NUL-delimited Git configuration output, rejects control characters in raw and effective URLs and canonical local paths, and authorizes only the remote(s) used. It uses Git's `ls-remote --get-url` without network access for ordinary rewrites. Push-only rewrites are selected from NUL-framed configuration using Git's longest-prefix rule; ambiguous equal-length alternatives are refused. Explicit push URLs do not use `pushInsteadOf`. The permanent real-Git tests cover the stronger newline case, CR, tab, escape, DEL, malformed NUL config, encoded and canonical-path controls, selected rewrites to unauthorized repositories, longest-prefix and push-URL semantics, all used push URLs, and unrelated remotes. Same-user configuration changes after validation remain best effort under the approved threat model. R229 remains open for the broader executable-content and security-boundary validation; this fix does not claim to close it.

At this checkpoint the release-blocker count remains **5**: R005, R026-U, R111, R229 and R231. Windows-port and AI-on-hold entries are excluded. Focused native Git tests: 15 remote-scope tests and all 32 entry-point tests passed. Full test results and the commit are reported in the checkpoint response; platform and packaged-app limits remain as previously recorded.


## Release checklist

| ID | Task | Expected result |
| --- | --- | --- |
| R111 | After building the final release assets, generate SHA-256 hashes for the Linux `.deb` and both signed macOS `.app.tar.gz` assets and update `nix/sources.json`. | The Nix package installs successfully using those exact published assets. This is a release checklist item, not a code blocker. |

## Release-blocker validation checkpoint (2026-10-29)

R005 is fixed and committed as `5d700b9`. The server's UI request ID is independent of the caller-supplied socket ID, allocated monotonically without wrapping, and associated with its target window. Unknown, late, duplicate and wrong-window replies are dropped and logged. The 18 control tests, full native suite (1,665 passed, 3 ignored), Clippy, frontend type checking and lint, and full frontend suite (5,487 passed, 2 skipped) passed. Lint reports 80 existing warnings.

### R026-U — assessment, no implementation

The safe writer does **not** stage a sibling file: `private_staging::staging_root` uses the system temp directory only and requires the target to have the same device. Consequently separate volumes fail explicitly. A same-volume sibling would cover many cross-volume cases but can expose private draft contents through inherited ACLs and can be picked up by `git add --all` even when the original `.env` is ignored. The previously approved policy requires private staging outside Git worktrees; a private sibling alone does not satisfy it. A verified private, non-worktree staging location on the same volume is a potential design, subject to available directory permissions and filesystem guarantees.

Other cases include read-only or non-writable destination directories; unsupported or unreliable same-filesystem rename/hard-link semantics; inaccessible or non-private staging roots; ownership, ACL or extended metadata that cannot be read, reproduced and verified; unsupported/content-dependent metadata; disk-full or I/O errors; and on Linux filesystems outside the ACL allowlist, including NFS and many FUSE/network mounts. Actual behavior varies by filesystem; no blanket claim that every network or FUSE mount lacks atomic rename is made. **Recommendation: refuse safely with a clear error and retain the dirty buffer**, rather than silently fall back to non-atomic writes. User decision requested; no change to R026-U is made.

### R229 — Git executable configuration and remote boundary validation plan

Automated here:
1. Run `git_executable_refusal`, `git_entrypoint_guard` and `git_remote_scope` against disposable repositories. Expected: executable hooks, filters/helpers and unauthorized selected local remotes are refused before execution; safe repositories work. **Passed:** 8, 32 and 15 tests respectively in the full native run.
2. Run `bun scripts/git-worker/smoke.mjs`. Expected: XPC peer, entitlement, signature, confinement and malformed-message tests pass; candidate execution remains explicitly unavailable. **Passed** on macOS in a disposable test bundle. This tests the helper, not Source Control's live Git execution.
3. Build an ad-hoc macOS app bundle and inspect its helper. **Built** `target/debug/bundle/macos/Oarlock.app`; the embedded helper passes strict signature verification, and the bundled CLI reports version 0.1.0. The outer debug app is linker-ad-hoc-signed with no sealed resources, so strict outer-bundle verification failed; this is not a signed-distribution test. No packaged Source Control interaction was automated.

Manual on a signed release candidate, using disposable repositories and harmless marker files:
1. Configure an executable pre-commit hook and then a clean filter that each writes a marker. Attempt Commit and Stage in Source Control. Expected: a clear refusal naming the configured extension, no marker created, and no unintended change to index or branch.
2. Remove those extensions; stage and commit a normal file. Expected: both actions succeed. Add a separately unauthorized local remote and fetch from a different authorized remote. Expected: the selected remote works while a selected unauthorized remote is refused.
3. Run `scripts/git-worker/verify-app.mjs` with the release team identity on the final signed app. Expected: outer app and independently sandboxed helper signatures and entitlements verify. Exercise any intended helper integration separately; the current capability says `candidate_execution_unavailable`.

### R231 — preview authorization validation plan

Automated here:
1. Run the native `asset_all_folders` tests. **Passed:** 14 tests, including 7 handle-focused cases for replaced files/parents, symlink targets, revoked authorization, FIFO rejection and foreign-origin handling. These drive native response code, not a packaged webview.
2. Build a local macOS app package. **Built** the ad-hoc debug bundle as above. Its outer signature is not a valid distribution signature; no scripted packaged-webview authorization test exists in this batch.

Manual on a signed release candidate with a fresh isolated profile and disposable files:
1. Turn off “Allow the app to access all folders”; open one test workspace. Preview a normal image in that workspace. Expected: it renders.
2. Add a symlink in that workspace pointing to a distinguishable image outside every authorized workspace, without opening or authorizing the outside folder. Preview the link. Expected: the outside image does not render and access is refused. Repeat with a symlinked parent directory.
3. Enable app access to all folders and retry a non-hidden outside image, then disable it and request a fresh preview. Expected: access follows the setting for each new request; dot-file restrictions continue to apply. Test only non-sensitive disposable files. Confirm ordinary reload and tab-close behavior.

**Open release blockers: 3** — R026-U, R229 and R231. R111 is now a release checklist item; Windows-port and AI-on-hold rows remain excluded. The macOS release build, signed-package live checks and Linux runtime remain unverified. No push.


## R026-U macOS implementation checkpoint

The approved policy is to refuse with a clear error and retain a dirty buffer. On macOS, Foundation creates an item-replacement directory appropriate to the destination volume. The directory is checked against worktrees, verified by its opened identity and made private before content is written; metadata, ACL and conditional-save checks remain in force. macOS refuses opening the shared TemporaryItems parent even for its owner, so cleanup rechecks the returned directory path and identity before removal; a noncooperating same-user process can race that final check under the approved best-effort policy. Failures name the target and the staging or atomic-replacement error.

A real APFS disk-image regression confirmed staging and conditional save on a different device from system temp and verified neither `git status` nor `git add --all` exposes the ignored draft. The image was detached and removed. A read-only-directory test retains the original and names the file; the frontend regression retains the dirty draft on a replacement failure. Linux O_TMPFILE implementation remains pending the requested decision on where to link the unnamed file before rename; R026-U therefore remains open. MAJOR triage has not started.

| ID | Severity | Area | Finding | Disposition |
| --- | --- | --- | --- | --- |
| R235 | MAJOR | Editor saving | Some unsupported filesystems cannot preserve metadata or provide verified atomic replacement, so users cannot save through Oarlock even if they would accept a non-atomic write. | Future explicit “Save anyway (non-atomic)” option requires a separate design; do not build it in this batch. Current policy refuses and keeps the buffer dirty. |

## R026-U Linux cleanup design — decision pending

The user selected Linux `O_TMPFILE` and this publication-location order: a private directory under the same-filesystem Git common directory for repository files; a hidden target-directory sibling for files outside Git repositories; otherwise a private same-filesystem directory such as a qualifying XDG cache, or a clear refusal. Linked worktrees whose common directory is on another filesystem must take the fallback. The user additionally requires startup cleanup of abandoned Git staging entries.

**Problem:** the app cannot infer which names in a repository were created by Oarlock merely from their names or owner, and the repositories containing them are not all available in the native workspace registry at startup. Deleting matching names risks deleting unrelated repository data or another active save. Scanning arbitrary repositories at startup cannot reliably locate every prior staging directory, especially when a volume is offline.

**Options:** (1) a small, durable, profile-specific native cleanup journal recording the staging parent, random name and file identity before creating a link, with an exclusive per-file lock held until publication/cleanup; at startup, reopen without following links, verify directory and file identity and remove only matching, unlocked records; retain unavailable-volume records and retry when the repository is reopened; (2) avoid a persistent journal and clean only when each repository is reopened, with weaker startup coverage. Recommended option 1. The journal must be bounded, updated durably before a name is published, preserve nonmatching or unrecorded entries, never wait indefinitely for locks, and refuse a new publication when recovery ownership cannot be recorded. Git common directories and linked-worktree pointers must be validated before writing; unauthorised or unsafe locations use the fallback or fail closed. This is an architecture proposal, not implemented pending the user's decision.

**Independent Linux probes:** in an existing network-disabled Linux container, as an unprivileged user with all capabilities dropped and two separate tmpfs mounts, `O_TMPFILE` was invisible before linking; linking within the repository's private Git directory followed by rename succeeded; a cross-filesystem `linkat` failed with `EXDEV`. A second disposable Python prototype verified that identity-recorded stale entries can be removed while a separately locked entry and an unrecorded file survive. These validate primitives only: they do not implement the Rust journal, exercise Git status, test a real linked worktree, or prove crash-safe ordering. The existing images do not contain a Linux Rust toolchain or Git. No production changes or R026-U Linux fix have been made in this continuation. R026-U remains open; the 56-finding MAJOR triage has not started.

## R026-U Linux staging checkpoint

The user superseded the journal proposal: cleanup is opportunistic before each save, with no startup sweep or persistent ownership journal. On Linux the candidate is created with `O_TMPFILE` in the target directory and locked through publication. For a repository, the publication link is under a private `oarlock-staging` directory in the verified Git common directory on the target filesystem. A non-repository file uses a hidden sibling name. When the repository common directory is unavailable or on another filesystem, a private, same-filesystem XDG cache location is used if safe; otherwise the save is refused. Git metadata pointers and linked-worktree backlinks are checked without executing repository code. If `O_TMPFILE`, metadata preservation or publication is unsupported, the save is refused and the editor keeps its dirty buffer.

Cleanup scans only the chosen directory, removes only regular files with the exact Oarlock PID/random pattern that are older than one minute and can be exclusively locked, and never follows symlinks or recurses. Locked, recent, differently named, non-owned and special entries survive. This follows the user's assumption that the matching filename pattern is reserved for Oarlock; there is no journal proving ownership of matching files. A separate same-user process racing path validation remains best effort under the existing threat model.

Linux tests in a network-disabled container use two tmpfs mounts and real Git repositories. They cover stale removal, locked/recent/unrelated retention, symlink and FIFO safety, non-repository sibling publication, Git staging invisibility in both status and index, and a real linked worktree whose Git common directory is on another filesystem, including XDG fallback and explicit refusal without it. Wider filesystem and Git index publication tests are also exercised; macOS publication regressions remain covered. R026-U is addressed for supported filesystems; unsupported atomic publication and metadata remain explicit, non-destructive refusal cases. R235 remains the future non-atomic override and is not implemented.

## R026-U validation and ownership triage checkpoint

Linux staging is committed as `517be2c`; macOS same-volume staging was committed as `f753c64`. Linux cleanup is opportunistic, not a startup sweep: the user's no-journal decision supersedes the earlier proposal. A real Git repository on a distinct tmpfs exercises private Git-common-directory staging and checks both `git status` and `git add --all`; a separate tmpfs hosts a linked worktree and tests the private-cache fallback and safe refusal. Other Linux tests cover stale, locked, unrelated, symlink and special-file entries and non-repository siblings. The separately run macOS disk-image regression covers a different-volume target and Git invisibility; frontend save failure retains the dirty buffer. R235 remains open for a separately designed non-atomic override.

Validation: macOS native suite 1,666 passed, 4 ignored; strict all-target Clippy passed; frontend 5,488 passed, 2 skipped, types and lint passed (80 pre-existing lint warnings). Linux full library run: 1,456 passed, 9 failed, 3 ignored; all nine failures were reproduced against the unchanged baseline. Seven are the window-restoration issue R236 below and two are WSL-supervisor tests in the container. A current-source rerun excluding those nine baseline test names and other tests under the same filters passed 1,452 tests, with 3 ignored and 13 filtered, plus 10 protocol tests. It used two separate tmpfs volumes and included all eight Linux staging tests. Linux strict Clippy remains blocked by pre-existing platform warnings; no claim of a clean Linux Clippy run. A subsequent diagnostic run accidentally reused the baseline binary because the two source trees shared a build cache; its 50 failures are not results for the committed implementation. The correct current module graph was forced to rebuild before the passing rerun.

| ID | Severity | Area | Finding | Disposition |
| --- | --- | --- | --- | --- |
| R236 | BLOCKER (Linux) | Saved-window restoration | Linux restoration calls `sync_all` on an `O_PATH` directory handle and gets `EBADF`; six recovery tests and one window-adoption test fail. The same failure occurs on the unchanged baseline and in an independent non-root Linux syscall probe. | Saved state is preserved and recovery stops with an error. Full graphical app startup was not tested. Investigate separately; Linux support is secondary to macOS for this release. |

### MAJOR ownership, ordering, and cancellation — started

The requested group contains 56 original findings. **Closed or deduplicated: 0; still open: 56.** Source checks have begun, but the whole group has not been revalidated or ranked; do not interpret the old breadth findings as confirmed live reproductions. Preliminary checks include R004, R008–R010, R013, R016–R018, R020–R021, R025, R035–R038, R042, R050, R061–R066, R075–R076, R080, R085, R087, R097, R101, R108–R109 and R212–R214. No finding in this group has been fixed in this checkpoint.

**First-priority data-loss risk, R020:** `useTabCloseGuards` remembers the IDs of dirty buffers at the bulk-close prompt, but not their revisions. When the user confirms, it awaits another hazard check and only asks again for newly dirty IDs; edits to an already-acknowledged dirty buffer are indistinguishable from the acknowledged version. Thus those newer edits may be discarded. The current source and the existing hazard comparison confirm the missing revision check; a mounted race reproduction has not yet been run. Other potential high-impact findings still require individual validation before their tier and resolution can be counted. AI-related implementation remains on hold.

### AP013 — bulk-close revision protection (proposal, not implemented)

**Problem:** R020 needs an ownership snapshot that the bulk-close flow does not currently carry. The application-close guard already exposes and compares editor close revisions, but the tab-close guard receives only a dirty-state callback.

**Options:** (1) reuse the existing editor close-revision callback in the tab-close guard, record acknowledged revisions with the pending confirmation, and recheck after asynchronous hazard evaluation; if any still-dirty buffer changed, show confirmation again. Cover edits before confirmation and during the awaited check, clean saves, closed tabs and new hazards. (2) Freeze affected editors while the prompt/check is active; this changes editing behavior and needs reliable unfreeze on every exit.

**Recommendation:** option 1, consistent with the previously approved window-close behavior. Passing the callback and expanding pending-close state changes the shared close contract, so no implementation is made pending the architecture decision. The triage stops here under the requested proposal checkpoint; the other 55 findings remain to be individually validated and ranked. No push.

## Ownership, ordering, and cancellation: 56-finding triage

AP013 was approved. R020 is fixed by `5b5e167`: bulk-close confirmation now uses the existing close-revision mechanism, rechecks after terminal hazard checks, and asks again for new edits. Hook regressions cover edits before confirmation and during the asynchronous check, and a save during the check. Full frontend checks passed: 5,491 tests passed, 2 skipped, types and lint passed (80 existing warnings). The first sandboxed full run could not bind its loopback servers; the unrestricted rerun passed.

Each row below was checked against the current implementation. Except for R020, these are source-level validations of the described paths and potential interleavings, not claims that a live race was reproduced. A risk belongs in Tier 1 when the described path could lose or corrupt user data; its exact trigger and impact still need focused testing before a fix. Windows/WSL-only issues are labelled; AI implementation remains on hold. No duplicate was closed without evidence.

**Counts:** 1 closed, 0 duplicates; 55 open: Tier 1 = 12, Tier 2 = 27, Tier 3 = 15, Tier 4 = 1.

| ID | Result | Current-code check / impact |
| --- | --- | --- |
| R004 | Tier 2 | Native forwarding and frontend context still fall back from a missing explicit caller to the active window and space. |
| R008 | Tier 2 | Explorer search still samples the environment without depending on it; matching roots can retain other-environment results (WSL). |
| R009 | Tier 1 | Explorer's confirmation still keeps a path-only target and reads the live selection; a surviving menu could delete the wrong entries. Live navigation remains to reproduce. |
| R010 | Tier 2 | Directory refresh has a workspace generation but no per-directory ordering; late listings can replace newer ones. |
| R013 | Tier 3 | The supersession table still gives new overflow keys untracked tickets; older work for such a key cannot be superseded. |
| R016 | Tier 3 | Several tab and pane state updaters still return disposal information through variables read immediately outside React's updater. |
| R017 | Tier 2 | Commit-file diff reuse still matches repository, SHA and path without the active space. |
| R018 | Tier 2 | Space-switcher pointer cancellation still calls the pointer-up path, which can commit the drag. |
| R020 | CLOSED | `5b5e167` rechecks acknowledged buffer revisions before bulk close and includes asynchronous regression tests. |
| R021 | Tier 3 | Quick Terminal still remounts the next pane immediately on exit even as it hides the window. |
| R025 | Tier 2 | Distribution refresh still applies every completion without a request generation (Windows/WSL). |
| R035 | Tier 1 | New File still reads the ambient environment after awaiting authorization and can create an unintended file in another environment (WSL). |
| R036 | Tier 2 | File-written events still match path without environment; regular reload refuses dirty buffers, limiting the established impact to unwanted reloads (WSL/path aliases). |
| R037 | Tier 3 | Discard coordinator Retry attempts still share client/listener slots without an attempt identity. |
| R038 | Tier 1 | A thrown document-mutation application still abandons the remainder of a sequenced batch; stale bindings can endanger later saves. No data-loss reproduction yet. |
| R042 | Tier 3 | The Vim command slot still waits for an unresolved continuation even after owner invalidation. |
| R047 | Tier 2 | LSP navigation checks view lifetime but not request order or the requested document snapshot. |
| R050 | Tier 3 | LSP install recheck can complete after dismissal or leave its checking state stuck on a failed save. |
| R061 | Tier 2 | Opening the Git graph still accepts an asynchronously resolved repository without checking the initiating context. |
| R062 | Tier 2 | Nested repository discovery still depends on folder alone, not the environment (WSL). |
| R064 | Tier 2 | A refreshed Git status still retains old repository upstream metadata when deciding auto-fetch. |
| R065 | Tier 3 | Remote Git actions still have no synchronous in-flight admission guard; busy can clear while another action runs. |
| R066 | Tier 3 | Native PTY startup still registers the spawned session after awaiting spawn without checking whether its page closed. |
| R075 | Tier 3 | An older terminal restart can still resume after close and clear a newer initialization. |
| R076 | Tier 1 | The PTY writer still drops a failed batch, resumes later input, and reports failure only to the console; input or commands can be corrupted. |
| R080 | Tier 1 | Clipboard capture and paste confirmation still await while later terminal input can pass them, potentially changing commands. |
| R081 | Tier 2 | Registered-program file drops still omit the source environment, unlike shell insertion (cross-environment/WSL). |
| R085 | Tier 2 | History popover reads still lack request ordering and destruction checks. |
| R087 | Tier 1 | Retargeting the shared shell editor still uses a history-recorded replacement, so Undo can restore another leaf's text over its draft. |
| R097 | Tier 2 | Installed-font lookup still caches an empty or failed lookup as null without retry. |
| R101 | Tier 2 | Linux portal initial color-scheme read can still overwrite a newer change signal. |
| R108 | Tier 2 | The cwd dropdown still samples the ambient environment and accepts out-of-order replies (WSL for cross-environment case). |
| R109 | Tier 2 | A delayed shader import can still overwrite a newer selection or reset. |
| R141 | Tier 3 | OAuth cancellation still does not interrupt preparation or token exchange; final token publication retains its cancellation guard. AI on hold. |
| R144 | Tier 1 | Skill enablement still clones, saves and replaces settings outside one transaction, allowing concurrent toggles to be lost. AI on hold. |
| R149 | Tier 1 | Agent launcher still saves a whole stale local command map, potentially restoring another window's edits. AI on hold. |
| R150 | Tier 3 | Agent review still marks a round reviewed before asynchronous import/submission and lacks failure recovery. AI on hold. |
| R151 | Tier 3 | Pending agent review still selects only the first agent for a session and can strand another's review. AI on hold. |
| R152 | Tier 3 | The dedicated skills watcher still only logs watch/start failures, leaving consumers unaware of degraded coverage. AI on hold. |
| R155 | Tier 2 | Approval diff still marks an ID opened before its cancellable read, so an effect rerun can leave its diff absent. AI on hold. |
| R158 | Tier 2 | Local notifications still derive finish transitions from the currently selected chat rather than the originating chat. AI on hold. |
| R161 | Tier 2 | Composer drag delivery still discards the source environment before import (WSL); AI on hold. |
| R163 | Tier 1 | Model preferences still build whole arrays/maps from snapshots, so overlapping edits can lose saved choices. AI on hold. |
| R167 | Tier 4 | Mini-window drag still restores body selection only on pointer end, not unmount. AI on hold. |
| R172 | Tier 2 | Subagent deltas still discard older global revisions even when a newer delta affected another task. AI on hold. |
| R178 | Tier 3 | Sampling dialog unmount still removes its abort listener without aborting the active generation. AI on hold. |
| R180 | Tier 2 | User skill catalog still does not refresh for same-root environment or skills changes. AI on hold. |
| R181 | Tier 2 | Skill/trust refreshes still lack request ordering and the prompt lacks navigation ownership. AI on hold. |
| R182 | Tier 3 | Git skill preview still accepts a late result after close and can leave its candidate alive. AI on hold. |
| R183 | Tier 2 | MCP status snapshot still races listener registration and can replace a newer event-derived list. AI on hold. |
| R201 | Tier 1 | Independent theme-file ingestions still upsert in completion order and can persist an older theme over a newer save. |
| R202 | Tier 1 | Theme ingestion still uses the current environment rather than the write's owner, potentially persisting the wrong theme (WSL). |
| R206 | Tier 2 | Delayed theme/background imports still select their results after a newer choice or cancellation. |
| R212 | Tier 1 | Delayed `cd` still uses ambient environment and does not revalidate prompt/session ownership, so text can enter a different running program. |
| R213 | Tier 2 | Launch-file handling still sends host paths through the active space's file opener without a Local binding (Windows/WSL). |
| R214 | Tier 2 | Git gutter baseline still drops a response received before the CodeMirror view exists. |

Tier assignments are ordering priorities, not new severity determinations or proof of reproduced loss. Tier 1 AI entries remain held for the backend replacement; Windows-only entries remain relevant to the future port. No other production fixes were made during triage.

## Tier 1 fix checkpoint

Three further findings are fixed in addition to R020:

| ID | Commit | Change and verification |
| --- | --- | --- |
| R076 | `977dbbf` | The terminal writer stops and reports a persistent visible error on queue overflow or failed write rather than sending later input. Detachment invalidates a late old-PTY failure. Regression tests reproduce the previous behavior and cover overflow and replacement. Full frontend tests passed (5,493, 2 skipped), types and lint passed, macOS Rust Clippy and the native suite passed. An already-dispatched OS write cannot be recalled. |
| R087 | `506790e` | Replacing the shared shell editor's draft resets its existing CodeMirror history compartment. Undo no longer brings in another leaf's draft; edits within the current leaf remain undoable. Regression uses real CodeMirror state. Undo history is cleared on each leaf switch. Full frontend tests passed (5,494, 2 skipped), types and lint passed. |
| R009 | `051af2c` | Explorer delete confirmations capture workspace identity and the selected paths; changing either cancels the action. Explorer selection clears on workspace/root change. Regression checks matching, reordered and changed selections and workspace identity. Full frontend tests passed (5,495, 2 skipped), types and lint passed. A live cross-environment menu interaction was not reproduced. |

Updated group counts: **4 closed, 0 duplicates; 52 open: Tier 1 = 9, Tier 2 = 27, Tier 3 = 15, Tier 4 = 1.** The remaining Tier 1 entries are R035, R038, R080, R144, R149, R163, R201, R202 and R212. R144, R149 and R163 concern AI and remain on hold. R035 and R202 concern WSL; their port remains lower priority. Prior tier rows above record the status at the time of the triage and are superseded by this checkpoint.

### AP014 — ordered terminal input during asynchronous paste (proposal, not implemented)

**Reproduction:** a controlled `GhosttyInputController` test delays its clipboard snapshot, dispatches Paste then Enter, and observes the PTY receive Enter before the pasted text. The temporary reproduction was removed after the test; `/private/tmp/oarlock-r080-reproduction.log` records the run. The existing PTY writer orders only bytes after they reach it, so it cannot order events while clipboard capture or paste confirmation is pending.

**Options:** (1) introduce a bounded per-terminal input gate that holds subsequent terminal-bound key/text/composition and paste operations in arrival order until the pending capture and any confirmation resolve, releases them in order, and cancels on terminal disposal/restart. Define clear failure/overflow behavior and cover IME, Kitty keyboard replies, prompt-mode routing, simultaneous pastes and focus changes. (2) cancel a pending paste when later input arrives and tell the user; this is simpler but lets an incomplete command receive Enter and would not preserve the requested input order. (3) suppress later input until the paste finishes and show that input was not sent; this avoids reordering but discards keystrokes.

**Recommendation:** option 1, using the existing terminal lifetime and bounded fail-stop policy while adding the missing input-order gate. The gate is a new mechanism, and needs an explicit decision under the standing triage rule. No R080 production code was changed. No push.

## AP014 continuation checkpoint

The user approved an ordered gate as part of the existing per-terminal writer and extended the requirement to app-generated writes such as `cd`: queued work must be cancelled when its terminal context changes. R035 and R202 are moved to the Windows port above; R144, R149 and R163 remain on AI hold. The remaining release Tier 1 findings are R080, R212, R038 and R201. Tier 2 remains 27 in the 56-finding group.

AP014 is in progress, not fixed: an uncommitted writer/controller prototype reserves positions for clipboard reads and confirmation, and focused tests exercise raw input and terminal-proxy command-bar routing. Direct CodeMirror command-bar input and context-bound app-generated writes still need integration and regression coverage. The initial focused run had one confirmation-test failure due to the prototype's additional promise turn; no passing full suite or complete fix is claimed. The production prototype must not be committed or released in this state.

## AP014 terminal input ordering

R080 and R212 are addressed by extending the existing per-terminal writer with bounded reserved input positions. Clipboard snapshots, paste confirmation, terminal-proxy input, direct command-bar editing and path-drop insertion retain their order. Queue overflow stops input visibly; restart and close discard pending work and report cancellation. Command-bar composition is held as one final edit when it begins while input is gated. App-generated writes retain their terminal, navigation, input, cwd and focus ownership until release; delayed `cd` verifies the original PTY and its actual shell before writing. New-terminal agent launches bind to the expected tab, and delayed agent follow-up Enter uses the same captured owner. Those AI-adjacent changes only cover terminal-write ownership; the AI backend remains on hold.

Focused regressions cover delayed paste before Enter, direct command-bar input, composition, out-of-order clipboard reads, a stale `cd` preparation, context-bound app writes, path-drop cancellation, bounded overflow, and visible restart/close cancellation. The full frontend suite passed 5,520 tests with 2 skipped; types and lint passed (80 pre-existing warnings), the full macOS native suite and strict all-target Clippy passed. An isolated macOS WKWebView fixture using the production CSP passed for typed command-bar input and a simulated composition sequence. A real hardware input method and the packaged application were not exercised; the webview fixture is not a full interactive IME validation. A change after the final release check or OS pipe write cannot be recalled; noncooperating same-user process races remain best effort under the approved threat model.

The 56-finding group now has 6 closed and 50 open: Tier 1 has 7 open, of which R035 and R202 are Windows-port items and R144, R149 and R163 are AI on hold. The remaining release Tier 1 findings are R038 and R201. Tier 2 remains 27.

## R038 depth validation and AP015 proposal

A controlled test held two ordered rename events behind the existing editor barrier, injected an exception applying the first, and confirmed that the second was discarded. A second controlled test confirmed that calling `noteRetarget` twice for the same one-editor rename creates two preservation credits: naive replay after a partial application can therefore leave a credit for an unrelated future move. These are helper-level reproductions, not a claim of a live application data-loss reproduction. Temporary probe tests were removed; results are in `/private/tmp/oarlock-r038-reproduction.log` and `/private/tmp/oarlock-r038-replay.log`.

### AP015: recoverable mutation delivery

**Problem:** `subscribeDocumentMutations` advances its sequence on receipt, abandons the rest of a batch when application throws, and Retry replaces the listener without replay. Applying an event can already have changed some tabs or added `noteRetarget` credits, so replay cannot assume the failed event had no side effects. Native `fs:mutation` is a fire-and-forget broadcast with no event history; a listener failure or reconnect can also miss events. Simply retaining the current JavaScript array does not cover missed broadcasts, and an unbounded array is not an acceptable recovery policy.

**Option 1, recommended:** extend the native mutation stream with a bounded in-memory journal and window-owned registration/acknowledgment. A window resumes from its last acknowledged sequence, keeps the existing listener active during application failures, and acknowledges only after a complete event is applied. Retarget preservation becomes idempotent for a specific event and tab, so retry after partial application cannot create duplicate credits. When lagging live windows fill the journal, refuse new Explorer mutations before changing the filesystem, with a clear recovery error; release closed windows' registrations. A window that cannot safely reconcile remains unable to apply risky saves until it recovers. Add tests for a partial event failure, two chained renames, lost-listener replay, duplicate delivery, overflow refusal, and window close/reload. This is an in-memory journal for the running application, not persistent cross-restart storage. It adds native commands/contract and needs the user's approval.

**Option 2:** keep a bounded local retry queue while the existing listener stays healthy, and fail closed into explicit editor recovery on a missed event or overflow. This is smaller, but cannot reconstruct events missed while the listener is unavailable and needs careful handling of already partially applied renames; users may need to recover affected drafts manually. Both options require idempotent per-event application and a defined overflow/failure policy. No R038 product fix has been implemented. R201 and the 27 Tier 2 findings remain pending; AI findings stay on hold and R035/R202 remain in the Windows port. No push.

## R038a/R038b: document mutation recovery checkpoint

R038 is split into R038a (a failed application abandoned later queued mutations) and R038b (stale document bindings after missed delivery). The mutation queue now retains and applies later events after reconciling a failure, reconciles all open workspace scopes on a detected sequence gap or listener registration, and also attempts reconciliation if listener registration fails. A failed scan retains the queue and exposes Retry. Mutation delivery resumes only after the reconciliation completes.

The existing conditional-save file identity is used to locate a missed rename within authorized workspace roots; if the identity is unavailable the original path is checked. A missing or ambiguous identity detaches an open editor draft, preserving its contents, and a document without an active editor receives an unavailable notice. Scans refuse with a visible error rather than assume a result after an unreadable directory, more than 100,000 entries, or five seconds. Multiple hard-link matches are not guessed. The previous global rename-credit counter was removed; buffer preservation now follows the actual editor session, and repeated application is idempotent. Pending scan results are rejected when their owning editor session or binding changes.

Regression coverage includes a failed event followed by a queued rename, reconciliation before subsequent events and on a sequence gap, retry after a failed scan, a missed filesystem rename, ambiguous hard links, repeated reconciliation, preserved detached drafts, and stale editor-session results. Focused frontend tests pass. The full frontend suite passed with local networking enabled: 601 files, 5,522 tests passed and 2 skipped; the later added stale-session test also passed in the focused run. The full native suite passed outside the sandbox: 1,483 library tests passed with 4 ignored, and all integration suites passed. Rust Clippy and frontend type and lint checks passed (lint retains existing warnings). Sandbox-only runs could not run the loopback and macOS watcher tests.

R038a and R038b are closed. In the 56-finding ownership group, 7 are closed and 49 remain open: Tier 1 has 6 (only R201 is in the current release scope; R035/R202 are Windows-port and R144/R149/R163 are AI-on-hold), Tier 2 has 27, Tier 3 has 15 and Tier 4 has 1. The app integration file reached the three re-edit limit in this batch; R201 and Tier 2 are not started. No push.

## R038 partial-rename follow-up

Reconciliation now passes the failed rename's destination as a candidate for documents without a saved file identity. The native check prefers the existing authorized source when both paths exist, otherwise accepts the authorized destination; identity-bearing documents continue to follow their verified identity even if another file replaces the source. Regression tests cover both present, source missing, replacement at source, repeated scans, and a destination outside the authorization boundary. The candidate is part of the existing reconcile call; no journal, acknowledgments, or Explorer admission check was added.

Concrete remaining limitation: open a document without a native identity (such as a cold or rendered-only tab), miss its entire `/workspace/a` to `/workspace/b` rename event, and later detect a gap from an unrelated event. Reconciliation has neither an identity nor that event's destination, so the existing `/workspace/b` cannot be distinguished from other files in the workspace. The regression `missed_rename_without_identity_or_destination_cannot_be_inferred` reproduces this; the document is marked unavailable instead of binding to an arbitrary file. Identity-bearing dirty editor drafts still reconcile or detach with their contents preserved.

## R201: ordered theme-file ingestion

R201 is fixed using the existing revisioned theme snapshots and conditional document-write ownership. Each window discards superseded file reads; ingestion records the catalog revision before reading, and native publication checks that revision and the exact opened file version while holding the same per-file lock used by editor saves. A newer write to the source file or newer change to that theme cannot be overwritten by an older read. A revision conflict caused only by an unrelated theme is retried against a fresh snapshot and file read. Closing the listener invalidates unfinished reads. The guard accepts authorized `.oarlock-theme` sources outside the app's theme folder, matching existing behavior. Same-user writers that bypass Oarlock's file lock retain the documented best-effort race.

Regression coverage includes delayed reads, cross-window revision conflicts, unrelated-theme retry, stale file versions and listener disposal; native tests verify stale catalog and file snapshots cannot publish. Full frontend tests passed (5,527 passed, 2 skipped), frontend types and lint passed, and strict all-target Clippy passed. Full native results are recorded at the batch checkpoint. The ownership group now has 8 closed and 48 open: Tier 1 = 5 (all Windows-port or AI-on-hold), Tier 2 = 27, Tier 3 = 15, Tier 4 = 1.

R201 final validation: the full native suite passed (1,487 library tests, 4 ignored, plus all integration suites) after the compatibility adjustment. The full frontend suite passed before that native-only adjustment.

## Tier 2: R017 commit-file diff scope

R017 is fixed: a commit-file diff is reused only when its owning space also matches. The regression covers identical repository, commit and file paths in two spaces, plus same-space reuse. The full frontend suite passed (5,528 passed, 2 skipped); types and lint passed. The full native suite remained green from R201; this change has no native code. Tier 2 remaining in the ownership group: 26.

## Tier 2: R018 cancelled space drags

R018 is fixed: pointer cancellation and lost capture abandon a drag without moving or activating anything, and only the initiating pointer can commit. Closing or unmounting the switcher releases the captured pointer and restores the prior text-selection style; cleanup also handles a capture that the browser already revoked. Regressions cover cancellation, unrelated pointers, normal completion and cleanup after revoked capture. The full frontend suite passed (5,531 passed, 2 skipped); types and lint passed. Tier 2 remaining in the ownership group: 25.

## Tier 2: R047 LSP navigation ownership

R047 is fixed: definition and reference requests share a per-editor ordering, and a response or results-panel selection is ignored if superseded, the document or selection changed, the editor was destroyed, or its pane became hidden and visible again. This uses the editor's existing visibility signal and LSP view lifetime; no persisted state or native interface was added. Regressions exercise overlapping definition/reference requests, edits, cursor movement, pane visibility changes and destruction. The full frontend suite passed (5,533 passed, 2 skipped), followed by the focused navigation tests after a test-only type correction; types and lint passed. Tier 2 remaining in the ownership group: 24.

## Tier 2: R061 Git graph context

R061 is fixed: delayed repository resolution for the Git graph is accepted only while its originating space, environment, tab and repository context remain current, and a newer request or unmount supersedes it. The guard follows the existing repository-targeting request ownership pattern. Regression tests cover out-of-order resolution and closure of the owning context. The full frontend suite passed (5,535 passed, 2 skipped); types and lint passed. Tier 2 remaining in the ownership group: 23.

## Tier 2: R064 fresh Git status metadata

R064 is fixed: each successful status read updates the repository's branch, upstream and detached state before the automatic-fetch decision and again after a fetch. Linked-worktree metadata remains intact. The regression covers adding and removing an upstream after a branch change. The full frontend suite passed (5,536 passed, 2 skipped), with the focused regression rerun after a test-only type correction; types and lint passed. Tier 2 remaining in the ownership group: 22.

## Tier 2: R214 first-load Git gutter

R214 is fixed: Git baseline reads start only after the editor view exists, and an obsolete read cannot dispatch to a retired view. A regression demonstrates that the first baseline marks changed lines when the view appears and that cancelled reads do not update it. The full frontend suite passed (5,538 passed, 2 skipped); types and lint passed. Tier 2 remaining in the ownership group: 21.

## Tier 2: R085 terminal history lifetimes

R085 is fixed: each command-editor view owns its latest history lookup and debounce, and dismissing, editing or destroying the view invalidates pending results. Failed lookups are handled without leaving the popover pending. Regressions cover Escape during a pending open, out-of-order results, a cancelled timer, view disposal and rejected lookups. The full frontend suite passed (5,541 passed, 2 skipped); focused tests were rerun after the final error-handling adjustment, and types and lint passed. Tier 2 remaining in the ownership group: 20.

## Tier 2: R097 installed-font retries

R097 is fixed: an empty or failed installed-font lookup is cached for the native scanner's ten-second rescan interval, then retried on demand. Returning focus to a window with expired negative results notifies existing font subscribers, so newly installed fonts or recovered lookups can load without restarting Oarlock. No idle timer is kept; if a font is installed while the window remains focused, the next relevant render or focus return initiates the retry. The regression covers a failed lookup, the cooldown, focus return and successful declaration. Full frontend tests passed (5,543 passed, 2 skipped); types and lint passed. Tier 2 remaining in the ownership group: 19.

R097 follow-up: expired negative font-cache entries are removed when focus requests a retry, preventing repeated focus changes from notifying every font subscriber when no active stack uses those entries. The retry regression now covers repeated focus; the focused font tests, types and lint pass.

## Tier 2: R109 delayed shader selection

R109 is fixed: each Settings view invalidates older shader reads and compilations, and explicit removal is ordered after any already-dispatched local save even if Settings closes. A reopened Settings view shares that ordering. An optional revision check on the existing native preference mutation prevents an older imported shader from overwriting a newer change in another window; unrelated preference changes are retried against a fresh snapshot. This adds no persisted state or new native command. Regressions cover slow imports, newer selections, Remove, Settings disposal/reopen, cross-window revision conflicts and unrelated changes; a native test rejects stale revisions. Full frontend tests passed (5,549 passed, 2 skipped); the full native suite passed (1,488 library tests, 4 ignored, plus integration suites), strict all-target Clippy, types and lint passed. Tier 2 remaining in the ownership group: 18.

## Tier 2: R010 Explorer directory ordering

R010 is fixed: each folder's latest listing supersedes older reads and delayed state updates without cancelling independent folders. Workspace changes and removed subtrees invalidate their pending reads, and superseded authorization waits do not start a directory read. The ordering records follow the existing tree lifetime and are cleared with its workspace or removed nodes. Regressions cover out-of-order completions, independent directories, removal and workspace reset. The full frontend suite passed (5,551 passed, 2 skipped); focused tests, types and lint were rerun after the final supersession check. Tier 2 remaining in the ownership group: 17.

## Tier 2: R004 control caller ownership

R004 is fixed: an explicit pane caller that no longer resolves returns `caller_unavailable` instead of falling back to the active window or space. The frontend also rechecks that caller after asynchronous window focus, so closing or moving it during the wait cannot redirect an open request. External CLI requests without a caller retain their existing active-context behavior. Regressions cover absent native callers, stale frontend callers and closure during focus. Full frontend tests passed (5,552 passed, 2 skipped); the full native suite passed (1,488 library tests, 4 ignored, plus integration suites); strict all-target Clippy, types and lint passed. Tier 2 remaining in the ownership group: 16.

## Tier 2: R101 Linux portal ordering, validation pending

R101 has a local implementation: a relevant `SettingChanged` signal invalidates an older initial `ReadOne` or fallback `Read`, so its late reply cannot restore the previous color scheme. The platform-independent ordering regression passes with `rustc --test`, and the macOS Clippy check passes. This workspace has only the macOS Rust target and no Linux runner, so the GTK/portal integration was not compiled or exercised here. R101 remains open in the Tier 2 count until a Linux build and portal smoke test confirm it; expected result: switch the desktop preference while the initial portal read is delayed, then observe that Oarlock keeps the latest preference.

## Tier 2: R108 working-directory dropdown

R108 is fixed: dropdown listings are scoped to the path, visibility setting and workspace environment, and late or closed-menu reads cannot publish. A stale menu selection also checks the current environment before issuing `cd`. Regressions cover the same path in different environments and out-of-order directory responses. Full frontend tests passed (5,554 passed, 2 skipped); types and lint passed. Tier 2 remaining in the ownership group: 15, including R101 pending Linux validation.

## AP016: R206 theme and background import publication (proposal, not implemented)

A controlled reproduction of the current callbacks confirmed both reported outcomes: start an import, select a different theme before the save completes, and the delayed import selects itself; start an image import, remove the background before conversion finishes, and the delayed import restores an image. The reproduction used the same ordering as `ThemesSection.tsx` with controlled promises; it did not exercise a packaged window. `ThemePastePanel` also leaves Cancel available during import. Background publication currently changes `backgroundImageId` and `backgroundKind` in separate native transactions, while image bytes live in IndexedDB; a failure, cancellation or competing window between those writes can leave a partial selection.

**Option A:** use per-view generations and the existing revision check to prevent delayed local reads from starting a stale save, keeping the two background preference writes. This is small and improves the reproduced races, but a cancellation or competing window after the first write can still see a partial selection, and an already-dispatched write cannot be recalled.

**Option B, recommended:** add one narrow atomic background-selection change to the existing revisioned native preferences command, updating the image ID and kind together with a revision check. Give each import a view-owned generation; keep imported image data as an unpublished candidate until the atomic selection succeeds, clean up unused candidates and superseded images safely, and invalidate unfinished work on a newer selection, Remove, Cancel or view close. Treat publication as an explicit commit point: Cancel is available during preparation, then disabled with a short Saving state once publication starts. Theme imports may finish saving a catalog entry, but only a still-current import may select it using a revision-checked preference update. This is a shared native preference contract and cancellation-policy change, with no new persisted journal or new native command.

Proposed regressions: delayed theme import versus a newer selection; Cancel while catalog saving; delayed image import versus Remove and another window's newer selection; preferences changing between preparation and publication; closing the view before publication; publication failure preserving the prior background and reclaiming the candidate; cleanup never deleting the currently selected image. R206 remains open. No implementation has been made pending the user's decision.

Current ownership-group Tier 2 count: 15. Of these, R206 is the remaining macOS-focused item requiring this decision; R101 has an implementation awaiting Linux GTK/portal validation; six items are Windows/WSL-oriented; seven are AI-on-hold (R161 also involves WSL). The original breadth and triage rows above are historical; depth checkpoints supersede their statuses.

### R101 Linux validation completed

R101 is closed. An isolated Linux arm64 container with GTK 3 and WebKitGTK 4.1 successfully ran `cargo check --locked --offline --lib` against the current color-scheme source (four existing Linux warnings). Under Xvfb and a private D-Bus session, a mock Settings portal emitted a newer dark `SettingChanged` signal before returning an older light `ReadOne` result. The current implementation left GTK dark; the same smoke fixture run against the implementation before `1b4778b` ended light and failed, confirming the test exercises the original ordering bug. This is a headless integration smoke test, not a packaged desktop-session test. Tier 2 remaining in the ownership group: 14.

### R206 / AP016 work in progress — quit decision and edit tripwire

R206 remains open. The uncommitted implementation uses revision-checked theme selection and a single conditional update for both background preference fields, cancels preparation, and allows publication to finish after the Settings view is disposed. Focused tests cover another window's newer choice, cancelled preparation, publication after view disposal, known and unknown save failures, and background removal; 26 focused tests, frontend types and lint passed. This does **not** establish completion during application Quit: Settings is outside the existing multiwindow quit agreement, and the native quit path can exit while publication is pending. A decision was requested on making Quit wait for an in-progress publication through a native-owned reservation, or cancelling Quit while publication saves. No new quit protocol has been implemented. An uncertain transport outcome retains a candidate image rather than risking deletion of a published image.

The publication helper reached the three-re-edit tripwire after its first passing version; stop further implementation in this batch. AP016 is not committed or ready to claim complete. The full frontend and native suites have not been run for these uncommitted changes.

Ownership-group counts remain Tier 2: 14, Tier 3: 15, Tier 4: 1; six Tier 3 and the Tier 4 finding concern AI and remain on hold. Initial source inspection identified possible remaining Tier 3 issues, but the requested Tier 3/4 pass and the 15-finding trust-and-authorization triage have not been completed. R101's Linux headless validation above needs no additional manual reproduction; the signed-release Git and preview checklists under R229/R231 remain outstanding.

### AP016 / R206: atomic import publication

The user clarified that publication must never be half-applied across Quit or a crash; no quit-protocol changes are needed. Theme catalog entries and background bytes are written before the final conditional preference update. Background kind and image ID commit together; imports cannot overwrite an existing theme entry, including one another window selected. A newer explicit selection advances the native preference revision even when it names the existing theme. Cancellation before publication leaves the current selection alone. Catalog entries are themselves visible user-owned themes, not disposable staging assets.

Background imports use dated, uniquely named IndexedDB assets and a cross-window Web Lock. On the next import, entries over one minute old are considered for cleanup; unrelated keys and the currently selected image are retained. Before deletion, a native preference revision barrier makes any earlier still-running publication fail its stale revision check, including a native save surviving a closed webview. An unknown transport outcome keeps its candidate for this later cleanup. Cleanup retries revision conflicts and skips eviction if a stable snapshot cannot be obtained. Platforms without the Web Locks API report that the import cannot safely run. A two-window macOS WebKit probe using the app's `tauri://localhost` scheme confirmed the second window could not acquire the lock until the first released it.

Tests cover cross-window newer choices, cancellation, durable preference snapshots on either side of publication, stale and selected candidates, a delayed native save, concurrent preference changes, and import collision. The full frontend suite passed (5,571 passed, 2 skipped); focused tests passed again after the final test assertion. The full native suite passed (1,491 library tests, 4 ignored, plus integration tests). Types, lint (83 warnings), and strict all-target Clippy passed. R206 is closed. Ownership-group counts: Tier 2 = 13 (all Windows/WSL or AI-on-hold), Tier 3 = 15 (six AI-on-hold), Tier 4 = 1 (AI-on-hold).

### R013: bounded search admission

When all 16 existing supersession slots are in use, a new search now receives a clear busy error rather than an untracked ticket that cannot be superseded. Existing tracked searches remain independent and slots become reusable when work finishes. Explorer displays search failures instead of reporting “No matches.” Regression tests cover repeated overflow, preservation of existing searches, slot reuse, and visible error text. Nine focused native tests, the full native suite, strict Clippy, the full frontend suite (5,571 passed, 2 skipped), the additional focused UI test, types and lint passed. R013 is closed; Tier 3 remaining = 14, including six AI-on-hold.

### R037: Discard registration retries

Repeated Retry clicks now coalesce while registration is in flight. This prevents overlapping native registrations from replacing one another's page tokens or an older listener cleanup from removing the current listener. The regression holds the retry registration pending and clicks Retry twice; it verifies only one new registration and listener are created. The existing late-unmount test still verifies registration cleanup. Focused tests (13), the full frontend suite (5,573 passed, 2 skipped), types and lint passed. R037 is closed; Tier 3 remaining = 13, including six AI-on-hold.

### R075: delayed terminal restart

After waiting for the old PTY to close, restart now checks the original session identity, generation and disposal state before clearing fields or starting the replacement. A close failure from an obsolete restart is ignored; a current failure remains visible. Regression tests cover two overlapping restarts, a replaced or closed session and a current close failure. Focused tests (18), the full frontend suite (5,577 passed, 2 skipped), types and lint passed. R075 is closed; Tier 3 remaining = 12, including six AI-on-hold.

### R021: quick terminal replacement

An exited quick-terminal shell is disposed and its pane is removed while the native window hides. A new pane starts only when the window next receives focus. The regression exercises three exit/hide/show cycles and confirms no replacement pane exists while hidden. The focused test, full frontend suite (5,577 passed, 2 skipped), types and lint passed. R021 is closed; Tier 3 remaining = 11, including six AI-on-hold.

### R065: concurrent remote actions

Each Source Control hook now synchronously reserves an action for its workspace and repository before dispatch. Another action for that repository returns busy until the first completes, while a different workspace remains independent. A regression holds a fetch pending, verifies a second request is refused and then verifies a later request can run. Focused tests (3), the full frontend suite (5,578 passed, 2 skipped), types and lint passed. This covers manual actions in one hook; it does not claim cross-window Git serialization. R065 is closed; Tier 3 remaining = 10, including six AI-on-hold.

### R050: language-server installation recheck

An installation recheck now belongs to the dialog and its selected server. Dismissal or replacement invalidates a pending binary lookup, and an obsolete completion cannot close a new dialog. Once the preference save starts, the dialog shows Saving and prevents an ordinary close until the save returns; a failed save is shown and the Check Again button becomes available. A parent that forcibly unmounts the dialog after native save dispatch cannot undo that already-started save. Focused regressions cover a dismissed lookup, missing binaries, a failed save and retry, and a replacement dialog while a save completes. Full frontend tests passed (5,581 passed, 2 skipped); types and lint passed. R050 is closed; Tier 3 remaining = 9, including six AI-on-hold.

### Remaining ownership proposals and AP016 follow-up

**R016, MAJOR — tab updates:** `removeTabsForSpace`, `closeTab`, `splitActivePane`, `closePaneByLeaf` and `closeActivePane` still read values assigned inside React state updaters as though those updaters must run immediately. Simply converting those five callers to use `tabsRef` can overwrite other queued updates: for example, a queued New Tab followed by a close planned against the old ref can replace the newly added tab. Proposal: make all tab updates use one synchronously maintained owner while retaining the existing tab API; test queued new/close, pane splits and disposal. This broadens the shared state contract, so it is pending the user's decision. Alternative: defer R016 without changing it.

**R042, MAJOR — stalled Vim command:** the current command slot waits for a suspended callback to settle, even after invalidation. The existing controlled helper reproduction uses a never-settling callback; another editor then cannot run its queued command. Releasing the slot without cleanup could leave shared macro or mapping state active, and an old continuation must not reset a later command. Proposal: extend the existing maintained Vim runtime with bounded cancellation, reset transient shared execution state before releasing the slot, and test a hung callback and its eventual late completion while preserving stored registers and ordinary commands. This changes the shared Vim runtime contract, so it is pending the user's decision. Alternative: defer R042 without changing it.

**R237, MAJOR — theme removed during import:** a controlled run of the production `importThemes` helper prepared a new catalog entry, removed it before the delayed catalog save returned, then allowed selection to continue. The helper returned `saved` with the selected ID absent from the catalog. This is an in-memory interleaving reproduction, not a packaged two-window test. AP016's crash/quit ordering remains as recorded above, but it does not coordinate a concurrent theme deletion. Proposal: coordinate native selection and deletion while protecting the catalog, validating selection and resetting a deleted selected theme to the default. This changes the shared deletion/selection contract; user decision pending. Alternative: record and defer the race.

### R066: terminal startup ownership

PTY startup now carries the existing native-issued page generation, as LSP startup already does. Native admission checks it before spawning, and publication into the session registry occurs under the page lock shared with reload/close. A shell whose startup finishes after its page was retired is unregistered and reaped. Real-shell tests cover both reload and close, plus successful startup and cleanup for a current page; the PTY bridge test checks that the generation is sent. This extends the existing `pty_open` argument with the already-established page identity, without a new page-lifetime mechanism.

The focused native page tests (31), PTY bridge tests (8), full frontend suite (5,581 passed, 2 skipped), types, lint and strict Clippy passed. The first full native run failed the existing agent-settings hard-link test with “destination moved”; it passed in isolation and the full native retry passed (1,493 library tests, 4 ignored, plus integration tests). R066 is closed. Ownership-group Tier 3 remaining = 8: R016 and R042 await the decisions above, and six findings remain AI-on-hold. Tier 2 remains 13, all Windows/WSL or AI-on-hold; Tier 4 has one AI-on-hold finding. The requested 15-finding trust-and-authorization triage has not begun.

### R237: reconcile a missing selected theme

The user chose recovery rather than cross-window locking. Once both preferences and the custom-theme catalog are ready, a missing selected theme resolves visually to the built-in default. The provider confirms the missing ID against fresh native snapshots, then conditionally persists the default and shows “Selected theme was deleted.” Preference revision conflicts are retried and a newer selection is never overwritten; failed catalog reads do not prove deletion. Regression tests exercise delete-before-selection, a catalog that was merely stale, a newer selection and an unrelated preference conflict. Full frontend tests passed (5,587 passed, 2 skipped), types and lint passed. R237 is closed; no cross-window theme lock was added.

### R042: bounded Vim command cancellation

The existing command ownership and failure-reset paths now retire a suspended command when its editor is invalidated or its ten-second deadline expires, even if the awaited callback never settles. Transient shared execution state resets before the next editor is admitted; the retired ticket prevents late resumable continuations and a late error cannot reset the new owner. Tests cover a never-settling callback, a queued command in another editor, a late completion and a non-worker deadline, alongside the existing search/macro-order tests. The trade-off is that arbitrary callback work outside the Vim adapter cannot itself be forcibly stopped; the adapter prevents its own stale continuations. As before, edits already made before cancellation are not rolled back. Focused tests (14), full frontend tests (5,587 passed, 2 skipped), types and lint passed. R042 is closed; Tier 3 remaining = 7, including six AI-on-hold and R016.

### R016: synchronous tab-state ownership

Tab and active-tab changes now update the existing refs synchronously before scheduling React publication. Every tab mutation uses that same owner, so a queued New Tab cannot be overwritten by a subsequent close, and pane IDs and disposal decisions no longer depend on React invoking an updater immediately. The public hook API and persisted data are unchanged. Regressions simulate deferred React publication and cover new-tab/close ordering, split IDs, pane disposal and a closed-tab return value. Focused tests, full frontend tests (5,589 passed, 2 skipped), types and lint passed. R016 is closed. All remaining ownership-group Tier 3 and Tier 4 findings are AI-on-hold; Tier 2 findings are Windows/WSL or AI-on-hold.

### R238: intermittent hard-link save refusal

**MAJOR, fixed.** The agent-settings hard-link regression failed once in the full native run and passed in isolation. A real macOS probe concurrently opened two hard links to one file: `F_GETPATH` returned the other link's name in 2,099 of 20,000 reads. This was not established as shared temporary test state: the production validation incorrectly assumed an open file has one stable path. Agent settings now compare the opened file's identity with the requested directory entry; the shared conditional writer likewise matches the opened file against its pinned entry and validates the pinned destination, instead of relying on the file handle's reported hard-link name. Symlinks and changed identities remain refused, and the previously accepted final external-writer race remains best effort. Regressions cover changed identity, hard links in different directories, the original flaky case and existing symlink protections. The full macOS native suite passed (1,495 library tests, 4 ignored, plus integration suites); strict Clippy passed. Linux runtime validation of this adjustment remains outstanding.
