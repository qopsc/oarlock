# Batch I design: O-10 (one run owner, revision-keyed credentials, durable chat metadata)

Phase 1 only. Nothing here is implemented. Branched from `review/codex-fixes` at e7db16e3.
All paths are relative to the repository root. File and line facts below were read in this worktree.

## 0. Summary of the three parts

| Part | Today | After |
| --- | --- | --- |
| 1. Run owner | `chatWork.ts`, `mcpRunLeases.ts`, `ownedStream.ts`, `composerWork.ts` and native `mcp/leases.rs` each track part of a turn | One page object (`lib/runOwner.ts`), registered once with native (`ai_run_begin`), released through one `close()` path; native keeps one record per run |
| 2. Credentials | random 128-bit `credentialVersion` namespace, copied and retired on each save | accounts keyed `<account>@r<secretsRevision>`; same staged write, no random namespace, no extra stored field |
| 3. Metadata | `ai_sessions_mutate` does `store.set`; disk follows on the plugin's delayed autosave; tombstones unbounded, revision memory-only | `store.save()` (durable: fsync and rename) inside every mutate, on the blocking pool; revision persisted; tombstones capped at 256 with a base-revision rule |

## Part 1. One run-lifetime owner per agent turn

### 1.1 Current mechanism and every file involved

Page side, all keyed by chat id, none aware of the others:

- `src/modules/ai/lib/chatWork.ts` (27 lines): `beginChatWork(id)` returns a finisher; `drainChatWork(id)` awaits all pending. Callers: `lib/transport.ts:115` (one per run, finished from the stream's release or the `finally`), `tools/shell.ts:104,167,206`, `agents/trackedSubagent.ts:38`. Drained only by `store/chatStop.ts:46`.
- `src/modules/ai/lib/mcpRunLeases.ts` (46 lines): `holdMcpRun(chatId, release)` registers a lease whose `release()` is shared and retryable; `releaseChatMcpRuns` (Stop), `hasMcpRunLeases` (`store/chatStore.ts:217`, LRU eviction guard). Created in three places in `transport.ts` (172 via `ownLease`, 186, 274).
- `src/modules/ai/lib/ownedStream.ts` (46 lines): wraps the UI stream; calls `release(reason)` once on complete, error, cancel or abort signal. Used once, `transport.ts:237`; its release callback also decides whether the lease becomes `pendingApprovalLease` (paused approval) and calls `finishRunWork`.
- `src/modules/ai/lib/composerWork.ts` (33 lines): `beginComposerWork(chatId)` is an AbortController set per chat; `cancelComposerWork` is called from Stop (`chatStop.ts:26`), `/stop` and `stop()` in `lib/composer.tsx:478,741`. Consumers: `composer.tsx` (submit, import, attach), `composerImports.ts`, `voiceRecording.ts`, `hooks/useWhisperRecording.ts`. Submit finishes it at acceptance (`composer.tsx:709-711`), "ownership transfers to the existing chat/model cancellation path".
- `transport.ts` (lines 95-280): `pendingApprovalLease`, `previousLease`, `lease`, `transferred`, `mcpPromise`, `finishRunWork`: the hand-written glue between the four.
- `src/modules/mcp/index.ts:20-65` (`mcpToolsForRun`: `ownLease`, `transferred`, `retainsProject`, `release` on `McpRunTools`) and `src/modules/mcp/lib/runServers.ts` (`captureRunServers`: `ownLease`, `releaseOwned`, its own `released`/`releasing`).
- `store/chatStop.ts:20-55` (`stopLocal`): the order today is `cancelComposerWork` -> `chat.stop()` -> deny approvals -> `drainChatWork` -> `releaseChatMcpRuns` -> `settleShellClosures`.

Native side:

- `src-tauri/src/modules/mcp/leases.rs` (144 lines): `Leases { owners: label -> Arc<()>, entries: u64 -> (label, OpenProject) }`. `owner()` is the page generation captured before an async open; `insert` refuses a dead generation and more than 64 per window; `release_window` drops owner and entries; `projects(label)` feeds `project::retained_projects`.
- `src-tauri/src/modules/mcp/project.rs:610-675`: `mcp_run_open` (resolves project, lists servers, inserts a lease only if the project has servers) and `mcp_run_release` (removes, emits `mcp:run-leases-changed`). Registered in `lib.rs:523-524`.
- `src-tauri/src/modules/mcp/mod.rs:72,89,153-157,190,324,437,690,737,776,861`: `McpState.leases`, `release_window`, `is_live` checks before publishing sessions.
- `src-tauri/src/modules/ai_chat_control.rs`: the Stop barrier (`ai_chat_register`, `ai_chat_stop`, `ai_chat_stop_ack`, `release_window`). Independent of leases: it knows windows, not runs. Reload is wired in `lib.rs:352-366` (`on_page_load` Started calls `release_window` for each owner).

Stated problem: five registries, five release triggers. Stop reaches the lease only through the page's `releaseChatMcpRuns`; if the page's ack fails nothing in native removes the lease, and a project record cannot be found by chat.

### 1.2 Replacement

**Page object** `src/modules/ai/lib/runOwner.ts` (new, one file, no dependencies, pure core plus a thin `invoke` shell):

```
type RunKind  = "prepare" | "turn" | "work";
type RunPhase = "preparing" | "accepted" | "running" | "paused" | "closing" | "closed";
type CloseReason = "complete" | "error" | "abort" | "cancel" | "stop" | "deleted"
                 | "navigated" | "abandoned" | "continued";

interface RunOwner {
  readonly runId: string;                // 128-bit hex from crypto.getRandomValues
  readonly chatId: string | null;
  readonly kind: RunKind;
  readonly phase: RunPhase;
  readonly signal: AbortSignal;          // aborted by cancel(), Stop, navigation, delete
  adopt(label: string, release: () => Promise<void>): void;   // run on close, LIFO
  onClose(cleanup: () => void): void;    // synchronous subscriptions (composer store watchers)
  cancel(reason: CloseReason): void;     // abort the signal only
  accept(): void;                        // preparing -> accepted (composer handed the message to the chat)
  wrapStream<T>(source: ReadableStream<T>, observe?: (chunk: T) => void): ReadableStream<T>;
  pause(): void;                         // running -> paused, resources kept (approval pending)
  close(reason: CloseReason): Promise<void>;   // the one release path
}
```

Module functions: `beginRun(chatId, {kind, native})` (kinds `prepare` and `work` are page-only unless `native: true`; a `turn` and the submit-time owner call `ai_run_begin`), `claimRun(chatId)`, `trackWork(chatId)` (a `work` owner, returns its `finish`), `closeChatRuns(chatId, reason)`, `chatHasRuns(chatId)`, `runsOf(chatId)` for tests.

Semantics that carry the existing guarantees:

1. `close()` is idempotent and shared: concurrent callers get the same promise. Each adopted release has its own done flag; a failed release leaves the owner `closing` and registered, and the next `close()` (Retry Stop) retries only the releases not done. This is `mcpRunLeases.ts`'s "failures stay reachable for Retry Stop", generalized.
2. Releases run LIFO: stream cancellation, then the project record (`ai_run_end`), then page subscriptions. `onClose` cleanups run synchronously once, first (the composer subscriptions, as `composerWork.finish` does now).
3. `wrapStream` is `ownedStream`'s body: pull, cancel, abort, complete and error all call `owner.close(reason)`; on `complete` with unanswered approvals, no pending abort and no error chunk it calls `pause()` instead and the owner stays registered with its resources (this replaces `pendingApprovalLease`).
4. `closeChatRuns(chatId, "stop")` is the whole of the old `stopLocal` body after `chat.stop()`: it aborts every `prepare` and `turn` signal of the chat, awaits every `work` owner's `finish` (the old `drainChatWork`), then `close()`s every `turn` owner including `paused` ones. `settleShellClosures` stays.
5. Preparation-to-turn hand-off (so the composer work and the turn are one object): the submit path calls `beginRun(chatId, {kind: "prepare", native: true})`, which performs `ai_run_begin` (today's `assertChatCanStart` plus the record). `composer.tsx:709` calls `owner.accept()` instead of `work.finish()`. `transport.run` calls `claimRun(chatId)`: the oldest `accepted` owner of that chat becomes `running`; otherwise (approval continuation, regenerate, retry) a fresh `turn` owner is begun. An `accepted` owner that nothing claims is closed `abandoned` when `sendUserMessage` settles (the `.finally` at `composer.tsx:~725`). Voice, imports and attachment reads keep using page-only `prepare` owners (they already go through `assertChatCanStart`), via `composerWork.ts` reduced to a 6-line facade that re-exports `beginRun` as `beginComposerWork`, so those four consumers and their tests change only their import.
6. Approval pause: when the run ends with approvals pending the owner is `paused` and remembered per chat. The next `transport.run` for that chat begins its owner, performs `ai_run_mcp_open`, and only then calls `previous.close("continued")` (the Review 52 order: acquire, then release). If the new run fails before acquiring, the `finally` closes both (today's `Promise.all([lease?.release(), previousLease?.release()])`).

**Native**, one record per run, in `src-tauri/src/modules/ai_runs.rs` (new, thin commands) over `mcp/leases.rs` (kept, re-keyed):

- `Record { window: String, chat_id: String, project: Option<OpenProject> }` keyed by `run_id: String` (validated: 32 lowercase hex). `Leases` keeps `owners` (page generation `Arc<()>` captured before any async work, as today) and the 64-per-window cap, now counted over records instead of project leases only.
- Commands (app windows only, `require_app_window`):
  - `ai_run_begin { runId, chatId }`: validates ids; refuses if the chat is stopping (`ai_chat_control::admit`); registers the window as chat owner (what `ai_chat_register` does, factored into one internal fn); inserts the record under the live page generation. Returns the Stop `Status`. Replaces the `ai_chat_register` call inside `assertChatCanStart` for runs; `ai_chat_register` stays for the idle `/stop` and for `stopChat`'s own registration.
  - `ai_run_mcp_open { runId, root, workspace }`: replaces `mcp_run_open`; same body, but sets `record.project` instead of inserting a lease, returns `{ projectKey, projects }` (no `lease` field). Unknown, foreign-window or dead-generation run id is an error.
  - `ai_run_end { runId }`: replaces `mcp_run_release`; removes the record; emits `mcp:run-leases-changed` only if it held a project. Foreign window or unknown id is a no-op.
- New native authority: `ai_chat_control::stop` calls `ai_runs::revoke_chat(app, chatId)` after emitting `ai:chat-stop` and before it waits for acknowledgments. Every record of the chat in every window is removed, so a page whose ack fails, a deleted chat, and a window that never answers cannot leave a project retained. The page `close()` still runs and is idempotent against it.
- `release_window` (reload, destruction): call sites in `lib.rs` unchanged; it drops owners and records, so `ai_run_begin` or `ai_run_mcp_open` queued across a reload fail `is_live` (existing mechanism, new tests).
- Removed commands: `mcp_run_open`, `mcp_run_release` (`project.rs:621,665`, `lib.rs:523-524`). Staying: `ai_chat_register`, `ai_chat_stop`, `ai_chat_stop_ack`, `ai_chat_control::admit`, `mcp/leases.rs`'s `owner`/`is_live`/`release_window`/`projects`/`all_projects`/`close`, and every `mod.rs` check.

**Sequence of a normal turn:** (1) composer submit: `beginRun(chat, prepare+native)` -> `ai_run_begin`; (2) preparation adopts its subscriptions with `onClose`; (3) `sendUserMessage` accepted -> `owner.accept()`; (4) `transport.run` -> `claimRun` -> `running`; (5) `mcpToolsForRun({ runId, signal })` -> `ai_run_mcp_open`; (6) `owner.wrapStream(stream, observe)`; (7) complete -> `close("complete")` -> `ai_run_end`, or approvals pending -> `pause()`; (8) continuation: `claimRun` fresh owner, `ai_run_mcp_open`, `previous.close("continued")`.

### 1.3 Exactly what is deleted (grep evidence from this worktree)

Files removed with their tests: `src/modules/ai/lib/chatWork.ts` (+`.test.ts`), `src/modules/ai/lib/mcpRunLeases.ts` (+`.test.ts`), `src/modules/ai/lib/ownedStream.ts` (+`.test.ts`). `composerWork.ts` keeps a facade (its registry and `cancelComposerWork` go; `composerWork.test.ts` moves into `runOwner.test.ts`).

Symbols removed; the same greps must return nothing after Phase 2:
`grep -rnE "beginChatWork|drainChatWork|holdMcpRun|releaseChatMcpRuns|hasMcpRunLeases|ownedStream\(" src` currently finds `shell.ts:104,167,206`, `trackedSubagent.ts:38`, `transport.ts:1,7,115,172,186,237,274`, `chatStop.ts:3,8,46,47`, `chatStore.ts:1,217`; all migrate to `trackWork`, `beginRun`/`claimRun`, `closeChatRuns`, `chatHasRuns`, `wrapStream`.
`grep -rnE "ownLease|retainsProject|pendingApprovalLease|previousLease|transferred" src/modules` finds `mcp/index.ts:26,32,35,54,55`, `mcp/lib/runServers.ts:10,24,53`, `transport.ts:95,110,111,171,188,247,276`; all gone, `McpRunTools.release` too (the record is ended by the owner, not threaded through the tools object).
Native: `mcp_run_open`, `mcp_run_release` (`project.rs:621,665`, `lib.rs:523-524`), the `Leases.next` counter and `u64` ids, `RunProject.lease`.
Net: roughly 120 lines of glue in `transport.ts` and about 90 in `mcp/` collapse; four page modules become one of about 170 lines.

### 1.4 Guarantees kept, residuals accepted

Kept: Stop retries failed releases; a stalled stream is released once; Stop denies approvals after the SDK drain; a refused admission leaves a waiting approval lease intact; an approval continuation acquires before it releases (Review 52); records bounded at 64 per window; an empty configuration retains no project; reload and destruction revoke pending starts; `hasMcpRunLeases` becomes `chatHasRuns` for chat-LRU eviction (a paused run still pins its chat); idle `/stop` still resets an unknown-cwd shell.
Added: native Stop revokes the chat's records without waiting for the page.
Accepted: (a) an unclaimed accepted owner closes only when `sendUserMessage` settles; (b) a begin whose reply is lost leaves a record until reload or Stop (the same as today's lost `mcp_run_open` reply, now chat-addressable); (c) page-only `prepare` and `work` owners die with the page and need no native record; (d) OS calls already started (keychain read, MCP spawn) are not interrupted, only their results discarded, as today.

### 1.5 Guarantee tests (each must fail if the named release is removed)

Phase 2 will mutation-check each by deleting the release and confirming the test fails.

Page, `src/modules/ai/lib/runOwner.test.ts` unless noted:
- `stop releases the stream, the mcp record and pending preparation`: a stalled source wrapped by a `turn` owner, a `prepare` owner on the same chat, `ai_run_end` mocked; after `closeChatRuns("stop")` assert the source was cancelled, `ai_run_end` invoked once with the run id, and the prepare signal aborted. Three assertions, three removable releases.
- `a failed release stays reachable and retry releases only what is left`: first `ai_run_end` rejects; `close` rejects; the second `close` calls only `ai_run_end`.
- `stop awaits work owners before records are released` (replaces the three `chatWork` cases).
- `src/modules/ai/lib/composer.submit.test.tsx`: `navigating to another chat or space cancels preparation and keeps the draft` (watcher aborts the signal, `ai_run_end` called, `value` and `files` unchanged); `navigation after acceptance does not cancel the running turn`.
- `src/modules/ai/store/chatStop.test.ts`: `deleting a chat stops its run and releases its lease` driving `useChatStore.deleteSession`; `a failed native stop still closes the page owners`.
- `src/modules/ai/lib/transport.test.ts`: the Review 52 case at line 567 becomes `a continuation acquires its record before the paused one is released`, asserting invoke order `ai_run_begin(new)`, `ai_run_mcp_open(new)`, `ai_run_end(old)`; `a paused approval keeps its chat pinned against eviction` (with `chatStore.eviction.test.ts`: `chatHasRuns`).
- `src/modules/mcp/lib/runServers.test.ts`: `a failed mcp open costs the run its project servers but not its record`.

Native, in `ai_runs.rs` and `mcp/leases.rs` tests:
- `page_reload_revokes_records_and_pending_starts` (generation captured before `release_window`; `insert` and `set_project` then fail; records gone).
- `stop_revokes_every_record_of_the_chat_in_every_window_and_leaves_other_chats`.
- `a_foreign_window_cannot_end_or_open_another_windows_run`.
- `capacity_is_per_window_and_counts_runs_without_projects`.
- `ai_run_begin_is_refused_while_the_chat_is_stopping`.
The three existing leases tests are rewritten for run ids, not deleted.

### 1.6 Doc sentences

`AGENTS.md`: rewrite "Active AI turns retain their submitted project's MCP servers through native, window-owned run leases (`mcp/leases.rs`)..." (~line 802) to name the run owner and records; "MCP ownership includes pending tool approvals..." (~836) to the `paused` phase; "Composer submissions have cancellable preparation (`ai/lib/composerWork.ts`)..." (~858) to the hand-off (`beginRun`, `accept`, `claimRun`); the Stop paragraph (~732) gains "native Stop revokes the chat's run records itself". Add a `### Review 108` entry. `docs/architecture/ai-subsystem.md`: the Composer section and the Invariants list get one bullet each (one owner per turn; Stop and delete go through it). `docs/architecture/security-model.md`: no sentence mentions run leases (`grep -n lease` finds none), so add one line under the MCP project-server bullet (~233): a project's servers stay callable by a turn only through its native run record, which Stop, reload and window destruction remove.

## Part 2. Credential namespaces replaced by revision-keyed accounts

### 2.1 Current mechanism

`src-tauri/src/modules/mcp/credentials.rs` (573 lines): `plan` writes a random 16-byte `credentialVersion` (32 hex chars) into every changed server, `account_at` appends `@<hex>` to each account (and validates the shape), `commit` stages copies into the new accounts, persists the settings file, then retires the old accounts (or the staged ones on failure). Files that touch the field: `settings.rs:157` (allowlist), `:297` (create refuses it), `:453-487` (plan, commit, publish); `credentials.rs` (`Version{namespace}` cache, `account()`, `published()`); `oauth/mod.rs:255` (`credentials::account`), `:663` (discovery fingerprint includes `credentialVersion`); `oauth/store.rs:112`; `storage.rs:102` (validates on load); `mod.rs:71,242,307,645,672,974`. `secretsRevision` already exists, is bumped on every credential or transport edit (`settings.rs:326`), and is what a launch and an HTTP session check (`credentials::launch`, `check_revision`) and what the stale-editor guard compares (`check_expected`).

### 2.2 Replacement (sequence)

1. Account naming: `account_for(server, base)` is `base` for revision 0 (and for project servers `prj-`, as now), else `format!("{base}@r{revision}")`. A server still carrying a legacy `credentialVersion` keeps resolving to `{base}@{hex}` until its next credential save (read-only compatibility, no migration write, matching the repo's legacy-field policy). `@r` cannot collide with the 32-hex legacy suffix or with a Windows chunk suffix (`:gen:`, `:<n>`); a test locks it.
2. `plan`: for each changed server, `next_revision = after.secretsRevision` (already bumped by `settings.rs:326` before `plan`); delete the nonce and the `credentialVersion` assignment; additionally remove `credentialVersion` from `after` so the legacy field disappears on that save. `writes` become `(account@r{next}, source = account under the OLD revision or legacy hex, replacement)`.
3. `commit` keeps its shape (stage, persist, then retire) and gains one first step, pre-clean: delete every `@r{next}` account the plan will not write (secrets no longer referenced, and the OAuth `tokens` and `client` accounts at `@r{next}`), so an orphan left by a crashed earlier attempt at the same revision can never become active. A staging failure deletes what this attempt staged and leaves the previous revision's accounts, the settings file and the in-memory snapshot untouched (unchanged from today).
4. `Version` cache keeps `revision` and `legacy: Option<String>` instead of `namespace: Option<Value>`; `account()` composes the name from them. `published()` unchanged in role.
5. OAuth: `store.rs:112` and `oauth/mod.rs:255` keep calling `credentials::account`; `oauth/mod.rs:663` drops `saved["credentialVersion"]` from the fingerprint (the revision is already in it). Sign-in still invalidates on any revision bump.
6. `settings.rs:157` and `storage.rs:102` keep accepting a stored legacy `credentialVersion` (load must not reject existing files) but `Create` still refuses it and no code path writes it.
7. Page: no change. `secretsRevision` is already in `config.ts` and in `Expected`.

Commands removed: none. Public IPC unchanged (`Expected.revision` and `Write` stay), so this part has no page/native skew.

### 2.3 Deleted (grep evidence)

`grep -rn "credentialVersion\|credential_version" src-tauri/src` today: `credentials.rs` (`account_at`, `Version`, `plan`, tests), `settings.rs:157,297`, `oauth/mod.rs:663`, `storage.rs:102`. After: only the read-compat branch in `credentials.rs::account` plus the two tolerant allowlist and load lines. Gone: the `getrandom::fill` nonce in `plan` (the crate stays; other users), the 32-hex shape check as an authority, `Version.namespace`, and the test `credential_namespaces_cannot_alias_legacy_accounts_or_chunk_suffixes` (replaced). Honest size note: `commit`, `Vault`, `Plan` and the stage-persist-retire order stay, because they are what makes "a failed save leaves the previous secrets active". The saving is the random namespace, its validation and its stored field, about 80 lines, not the whole 573.

### 2.4 Guarantees and residuals

Kept: a launch binds to the saved revision (`credentials::launch`); a failed keychain write, failed persist or failed retire never activates staged secrets; stale editors are rejected; HTTP sessions check the revision before requests and the OAuth credential lock re-checks it before reading or refreshing tokens (`oauth/mod.rs:346,392`).
Accepted: orphan `@r{n}` accounts after a crash between staging and persist, bounded to one revision per server and removed by the next save's pre-clean or by deletion; the revision is guessable, which is fine because it names an account, not a secret; saves still serialize through the settings lock (`hold_all`).

### 2.5 Tests (`credentials.rs` unless noted)

- `a_failed_keychain_write_leaves_the_previous_secrets_and_configuration_usable` (FakeVault `fail_set` on the second secret; old-revision accounts intact, `persist` never called, staged accounts removed, `account()` still resolves the old revision).
- `a_failed_persist_keeps_old_secrets_even_when_cleanup_fails` (kept from the current `failed_persistence...`, rewritten for `@r`).
- `a_stale_editor_cannot_overwrite_a_newer_transport_or_secret` (`settings.rs` tests: two editors at revision 3, the first commits, the second is rejected by `check_expected`, zero vault writes by the second).
- `an_http_session_checks_its_revision_before_reading_tokens` (`oauth/mod.rs` tests): a session opened at revision 2 after a bump to 3 returns the revision error and a counting vault records no `get`. If no seam exists it drives `store::read_tokens` with a counting vault; a one-line `pub(super)` may be needed and will be named.
- `a_leftover_from_a_crashed_stage_cannot_become_active` (pre-clean).
- `revision_accounts_cannot_alias_legacy_hex_or_chunk_suffixes`.
- `a_legacy_credential_version_is_read_until_the_next_save_then_dropped`.

### 2.6 Doc sentences

`AGENTS.md`: the "MCP credential saves (`mcp/credentials.rs`)..." paragraph (~925: "Replacement accounts use a native random namespace; unchanged secrets are copied into it, and only an atomic settings-file replacement publishes that namespace") becomes revision-keyed accounts with the pre-clean sentence; "OAuth accounts and token caches use the same namespace" (~936 area) becomes "the same revision". Add to Review 108. `docs/architecture/security-model.md:223` (Secrets bullet) gains the `<server>/env/<NAME>@r<revision>` account form. `ai-subsystem.md`: no sentence mentions it (`grep namespace` is empty); none to change.

## Part 3. Durable chat metadata with bounded tombstones

### 3.1 Current mechanism

`src-tauri/src/modules/ai_metadata.rs` (210 lines): `ai_sessions_mutate` takes a `std::sync::Mutex<u64>` (the revision, in memory only, reset to 0 each launch), reads `sessions` and `deletedSessions` (a `HashSet<String>`, never pruned) from the plugin store `oarlock-ai-sessions.json`, applies the delta, `store.set`s both, bumps the revision and emits `ai:sessions-changed`. It never calls `save()`: disk waits for the plugin's debounced autosave, so a crash loses the mutation after other windows already saw its event. The command is `async` and holds a std mutex on a runtime worker (the runtime has two workers). Page: `lib/sessions.ts:288,364,410` call snapshot and mutate; the `Delta` is built at 436. The same store file also holds the per-window `activeId` keys written by JS and `windows.rs`.

### 3.2 Replacement (sequence)

1. Pure core `MetadataDoc { sessions: Vec<Value>, tombstones: VecDeque<Tombstone>, evicted_through: u64, revision: u64 }` with `apply(&mut self, delta) -> Result<()>` (all-or-nothing as now; the existing `apply` tests move onto it). `Tombstone { id, revision }`.
2. Persistence boundary: `trait DocStore { fn load(&self) -> Result<MetadataDoc>; fn save(&self, &MetadataDoc) -> Result<()>; }`. Production impl `PluginDocStore(app)`: `store.set("sessions", ..)`, `set("deletedSessions", ..)` (array of `{id, revision}`), `set("sessionsRevision", n)`, `set("sessionsEvictedThrough", n)`, then `store.save()`. `Store::save` goes through the fork's `secure_file::write` (private temp file, `sync_all`, `renameat`, directory sync): durable and symlink-safe, and it serializes the whole store so the JS-owned `activeId` keys survive (a separate native file would need a migration and window-restore changes). Test impl `FileDocStore(path)` writes the same JSON shape through `fs::native_store::write` (the same durable pattern) and is what the crash tests reload from.
3. `ai_sessions_mutate` runs entirely inside `fs::blocking` (lock the state, `load`, `apply`, `save`, then `*revision = next`); on a `save` error the plugin's in-memory values are put back and the command returns the error with no event; the event is emitted after a successful save only. No std lock is held on an async worker any more.
4. Tombstone bound: keep the 256 most recent deletions. On eviction, `evicted_through = max(evicted_through, evicted.revision)`. The revision is persisted (`sessionsRevision`) so it stays monotonic across launches and tombstone ordering is meaningful.
5. Revision rule for creation: `Delta` gains a required `base: u64` (the revision of the snapshot the page built it from; `lib/sessions.ts` sends `latestSnapshot.revision`). A create is dropped (not an error, matching how a tombstoned create behaves today) when its id is tombstoned, or when `base <= evicted_through` and the id is not already present, because an eviction after that window's snapshot may have been this very deletion. A current page (it receives every `ai:sessions-changed`) never trips this; one idle through 256 or more deletions sees its create dropped and the next snapshot shows it, the existing visible behavior for a deleted chat.
6. Compatibility read: a legacy `deletedSessions` array of strings loads as revision-0 tombstones (oldest, evicted first, `evicted_through` stays 0 so no live create is wrongly dropped); the first save rewrites the new shape.
7. `ai_sessions_snapshot` is unchanged apart from reading through `DocStore`.

Commands removed: none. Contract change: `Delta` adds `base`.

### 3.3 Deleted

`grep -n "HashSet<String>\|deletedSessions" src-tauri/src/modules/ai_metadata.rs` finds the unbounded `HashSet` (`:7,57,66,135,138`) and the comment at `:126-133` ("the plugin retains its existing autosave"); all go. The snapshot comment at `:103-104` is replaced. Nothing is deleted on the page; `sessions.ts` only gains `base`.

### 3.4 Guarantees and residuals

Kept: transactions merge; invalid transactions change nothing; stale updates and creates cannot revive deletions; ordered snapshots and events by revision; every window gets the event.
Added: disk is the commit point (event only after fsync and rename); deletions survive restart; the set is bounded at 256.
Accepted: each mutate rewrites the whole store file (small: the sessions list plus `activeId` keys; mutates are user-rate: create, rename, approval mode, delete, one title derivation per chat); a JS autosave between our `set` and `save` can persist our values early, and on a failed save the rollback leaves disk briefly ahead of memory until the next save; a window idle through more than 256 deletions loses one creation to the stale-base rule.

### 3.5 Tests (`ai_metadata.rs`)

- `a_mutation_is_on_disk_before_the_command_succeeds` (apply and save through `FileDocStore`, drop the doc, reload from the file: the new chat is there; the plugin autosave never runs in the test).
- `a_failed_save_changes_nothing_and_emits_nothing` (injected failing `DocStore`).
- `a_deletion_from_another_window_is_not_resurrected_after_restart` (window A deletes, save, reload; window B's stale create with an older base is dropped).
- `the_tombstone_set_never_exceeds_its_bound` (300 deletions: 256 kept, `evicted_through` equals the highest evicted revision).
- `a_creation_older_than_the_oldest_kept_tombstone_is_refused_by_revision`.
- `legacy_string_tombstones_load_and_are_rewritten`.
- `revision_survives_a_restart`.
- A source guard, as `project_trust` did for origins: `the_plugin_doc_store_saves_before_returning` reads `ai_metadata.rs` and asserts `PluginDocStore::save` ends with `.save()`. It is named honestly as a guard, because no mock app runtime exists without a `Cargo.toml` change.
- Page, `lib/sessions` test: `mutate sends the base revision of the latest snapshot`.

### 3.6 Doc sentences

`AGENTS.md`: "Shared conversation metadata uses native `ai_sessions_mutate` transactions (`modules/ai_metadata.rs`)... Native revision numbers order snapshots and notifications; deletion tombstones prevent stale creation from reviving a removed chat" (~678) gains "Each transaction is saved durably before it is published (`store.save()`), the revision persists, tombstones are capped at 256 and a creation whose `base` predates the oldest kept tombstone is refused." `docs/architecture/ai-subsystem.md:79` (`oarlock-ai-sessions.json` holds only session metadata and the active id) gains the durability and bound sentence. `security-model.md`: no sentence on this store; none to change.

## 4. Page and native compatibility mid-migration (fail closed)

The page and native ship in one binary, so skew exists only in development (a rebuilt native with a stale dev-server page, or the reverse) and between commits of this batch. Rules:

- Removed or renamed commands fail by name: an old page calling `mcp_run_open` or `mcp_run_release` against the new native gets Tauri's "command not found"; a new page calling `ai_run_begin` against the old native gets the same. A failed `ai_run_begin` is a hard failure of the run (`beginRun` rejects, the composer toast shows it, nothing starts). Only `ai_run_mcp_open` keeps the documented soft failure (the run goes on without project servers).
- `captureRunServers` today swallows an `mcp_run_open` error (its `.catch` returns `lease: null`); that swallow is why a skewed page would silently run without leases. In Phase 2 it is narrowed to errors from `ai_run_mcp_open` on a begun record, and a missing record is an error.
- Changed payloads fail by schema: `Delta` is `deny_unknown_fields`; an old page omitting `base` is rejected by serde (missing field), and a new page sending `base` to the old native is rejected (unknown field). `ai_sessions_mutate` therefore errors and the existing ordered retry queue keeps the change local and visible instead of losing it.
- Stored data: the new native reads old files (string tombstones, `credentialVersion`, no `sessionsRevision`). An old native reading new files fails closed: `deletedSessions` objects do not deserialize as `HashSet<String>` (mutate errors), and an old native resolving accounts for a server whose `credentialVersion` was dropped finds no secret at the plain account (launch fails "missing secret"; it never starts with another server's secret). That is the downgrade story; it is stated, not engineered around.
- Commit order inside Phase 2 keeps each commit green: (1) Part 3 (self-contained), (2) Part 2 (self-contained), (3) Part 1 native commands added alongside the old ones, (4) Part 1 page migration, (5) delete the old page modules and the old native commands in the same commit as the last caller, so no commit has a caller without its command.

## 5. Open questions for the owner

1. Hand-off versus two objects per turn (1.2 item 5): the faithful reading of "holds the stream and the composer work" is a hand-off from the submit-time `prepare` owner to the turn through `claimRun`. For less risk, the submit owner can finish at acceptance as now and the turn begins its own: one class and one registry but two objects per turn. I recommend the hand-off with the `abandoned` fallback.
2. Part 2 removes the random namespace, its validation and its stored field, but keeps stage, persist, retire. Revision-keyed accounts need that to keep "a failed save leaves the previous secrets active"; I see no design that drops it and keeps the guarantee.
3. Part 3 chooses `Store::save()` on the shared plugin store over a new native file, because the file also holds JS-owned `activeId` keys and `windows.rs` state. A new file would be cleaner but needs a migration and window-restore changes outside this batch's ownership.
4. Files outside the stated ownership that Phase 2 touches: none expected beyond `docs/**` and `AGENTS.md`; `mcp/project.rs` (which hosts `mcp_run_open`) is inside `mcp/**`.
