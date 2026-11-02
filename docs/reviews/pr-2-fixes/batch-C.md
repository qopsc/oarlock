# Batch C: terminal input, replies and clipboard

Branch `worktree-agent-a5756476127b7650b`, based on `review/codex-fixes` at fe147a5.

## 1. Findings closed

| ID | Fix | Location | Test | Commit |
|----|-----|----------|------|--------|
| P-02 | The writer no longer calls `fail()` for budget overflow. An over-budget reply returns `false`; one input unit (a paste) may exceed the 256 KiB budget while nothing beyond it is queued, up to 8 MiB, else it is refused with a notice; `fail()` stays for real `pty_write` errors. Refusals reach a new `onRefused` callback and a toast. | `src/modules/terminal/lib/BoundedPtyWriter.ts`, `lib/inputNotices.ts`, `ghostty/useGhosttyTerminalSession.ts` | `BoundedPtyWriter.test.ts` (refuses input past its budget, takes one paste, keeps typing alive after a reply is refused, stays failed after a real write error), `inputNotices.test.ts`, `orderedPaste.test.ts` (refuses a paste over the hard cap) | 6eb3ea9 |
| T-04 | The writer test asserted the old behavior; rewritten to assert `enqueue(input)` stays true and `hasFailed` false after a refused reply. New `orderedPaste` tests drive the real controller with a stalled clipboard read plus held keys. Landed in the P-02 commit because the tests define the policy. | `BoundedPtyWriter.test.ts`, `src/modules/terminal/ghostty/input/orderedPaste.test.ts` | "keeps the terminal alive when keys pile up behind a stalled clipboard read", "types again after a stalled clipboard read times out" | 6eb3ea9 |
| P-03 | The action cap and an oversized slot now drop with a notice instead of `fail()`; reserved slots expire after 60 s (the 15 s capture plus 30 s page wait); held-key repeats stop queuing past 32 waiting actions (`deferInput(..., repeat)`). The cap and deadline landed with P-02 because they share its policy. | `BoundedPtyWriter.ts`, `GhosttyInputController.ts` (passes `event.repeat`) | "drops a reserved slot past the action cap", "releases a reserved slot nobody resolved", "coalesces held-key repeats", orderedPaste "drops held-key repeats" | 6eb3ea9, fbb1cef |
| P-01 | The core drops the reply that does not fit, logs once, keeps the whole replies already queued and the terminal. The `reply_overflow` flag, the `restty_write` error and the `i32::MAX` length sentinel are gone; the host no longer throws on it. Both artifacts rebuilt. | `packages/ghostty-core/adapted/wasm/src/oarlock.zig`, `lib/adapted/OarlockGhostty.ts`, `adapted/UPSTREAM.md`, both `.wasm` | `AdaptedGhosttyProtocols.test.ts` "drops the reply that does not fit, keeps whole replies and survives" (real WASM, both artifacts); `ghostty_artifacts.rs` passes unchanged | 98dadfb |
| P-05 | `inputRevision` bumps only for keys that type something; bare modifiers (Shift, Control, Alt, AltGraph, Meta, locks) do not. | `ghostty/input/terminalInputEncoding.ts` (`isModifierOnlyKey`), `GhosttyInputController.ts` | `GhosttyInputController.test.ts` "counts a key as input only when it types something" | 90b59c5 |
| A-01 | See the deviation below. `send_to_agent` waits for the Enter, returns an error (not `ok`) when the terminal changed so the line was typed but not submitted, and refuses when the terminal has no armed agent session (`useAgentStore.sessions[leafId]`). | `src/modules/ai/tools/agent.ts` | `agent.test.ts` (submits after the delay, reports failure before Enter, refuses a not-running agent) | 237b321 |
| P-04 | The user's Cmd+C and copy-on-select go through `copyTerminalSelection`, which toasts "Copy was replaced" when a program's write took the slot, or "Could not copy". | `src/modules/terminal/lib/terminalClipboard.ts`, `ghostty/useGhosttyTerminalSession.ts` | `terminalClipboard.test.ts` "tells the user when a program's write took the clipboard first" | ec4acb7 |
| O-02 | An effective `LC_ALL` that is not UTF-8 is left alone with a log warning. `LC_CTYPE` and `LANG` handling is unchanged. | `src-tauri/src/modules/pty/shell_init.rs` | `utf8_locale_leaves_an_explicit_lc_all_alone`; the precedence test lost its `LC_ALL=C` row | b840eb9 |

A-01 deviation: `agent.ts` documents that Claude Code reads a CR in the same chunk as the text as a literal newline, not a submit, so `instruction + "\r"` as one write would stop submitting. The two writes stay. The defect (the tool says `ok` while the line sits unsubmitted) is fixed by awaiting the delay and reporting the real outcome. P-05 narrows the window in which a bare modifier cancels the Enter.

P-02 note: an oversized paste is taken as one unit up to 8 MiB when the queue is under budget, rather than refused at 256 KiB, because a healthy PTY should accept a 1 MiB paste. The native side already bounds a write at 64 MiB (`MAX_INPUT_BYTES`) and tests it (`oversized_terminal_input_is_refused_before_a_stalled_writer`), so `session.rs` needed no change.

### Rework round (Opus review C-R1 to C-R7)

- C-R1: `reserveInput({ deadline: false })`, used by paste confirmation; test "still sends a paste the user confirms after the slot deadline window". Commit: "P-03 rework: give slots held for a user prompt no deadline".
- C-R3: held-key test asserts `pendingActions <= 33` and fails with the `event.repeat` hunk reverted (checked). Commit "P-03 rework: assert the repeat coalescing bound".
- C-R4: message made neutral ("A newer copy or a program's clipboard write replaced it"). Commit "P-04 rework".
- C-R2 and C-R6: `send_to_agent` asks `leafHasForegroundProcess` before typing and before Enter and refuses when the shell is at its prompt; the agent-record check was removed rather than kept as a hint, because it had no remaining decision to inform. `BoundedPtyWriter.enqueue` gained a `settled(delivered)` callback and the input owner a `writeDelivered`, so `ok` is returned only after the PTY took the Enter. "or resend" dropped from the error. Tests: shell at prompt, agent exits before Enter, no integration record, Enter cancelled before delivery, and the writer `settled` test. Commit "A-01 rework". Unknown or failed foreground lookups count as "not running" (the helper returns false on error), which errs towards not typing.
- C-R7: per-answer latch in `answerKittyRead` rewinds the reply queue to the answer's start when a packet is dropped. Artifacts rebuilt. No real-WASM regression test: Ghostty caps an answer at 32 MiB of data (about 43 MiB of base64), under the 48 MiB answer queue, so the drop cannot be triggered through the public API (a probe with two 25 MiB representations produced one complete, well-formed answer from Ghostty itself). The existing answer test passes against the new artifacts. Commit "P-01 rework".
- C-R5: prose corrected to the code (repeats drop silently; the Copy toast covers any newer write and other failures), and the R076 ledger line added to section 4.

## 2. Findings left open

None. `pty/session.rs` and `clipboard_write.rs` needed no edits.

Consequence of P-01 to know: a Kitty clipboard answer that exceeds the raised answer limit is now dropped (logged once) instead of ending the pane.

## 3. AGENTS.md edits

- Section "Terminal migration status", anchor "Terminal replies have a PTY budget of their own, apart from what the user types". Append: "Input has its own budget of 256 KiB: one paste may exceed it, up to 8 MiB, while nothing beyond the budget is queued. Input past the budget, a reserved input slot beyond 256 waiting, and a slot idle for 60 s are dropped with a notice; held-key repeats past 32 waiting and refused replies are dropped silently. None of them stops the writer. A slot that waits for the user (paste confirmation) has no deadline. Only a failed `pty_write` stops the writer, until the shell is restarted."
- Same section, wherever reply overflow is described as ending the pane: "A reply that does not fit the core's 256 KiB reply queue is dropped whole and logged once; the pane keeps running."
- Same section, after "Caps Lock and Num Lock are reported with every key": "Only keys that type something count as user input for app-driven input ownership; a bare modifier press does not cancel queued app input."
- Section "Frontend", module `agents/`, anchor "Delivery differs because only Claude's hook protocol can return terminal bytes". Append: "`send_to_agent` asks the PTY whether a program owns the foreground before typing and again before Enter (the agent record is not consulted, as it goes stale without shell integration), types the instruction, waits 90 ms, sends Enter and reports success only once the PTY took it; otherwise it returns an error saying the line was typed but not submitted."
- Same Terminal section, anchor "Explicit Copy buttons share ordering". Append: "The terminal's own Copy toasts when a newer write (a program's, or the user's next copy) replaced it, and on any other failure."
- Section "PTY shell integration", anchor "Shells advertise `TERM=xterm-256color`". Append: "A non-UTF-8 `LC_ALL` is left as the user set it; `LC_CTYPE` or `LANG` get a UTF-8 locale when they are the effective setting."
- Anchor "The adapted Ghostty revision is pinned in `packages/ghostty-core/adapted/UPSTREAM.md`": no change to AGENTS.md; the artifact sizes and SHA-256 values in that file are updated.

## 4. docs/architecture edits

- `docs/architecture/pty-transport-v2.md`, wherever the writer or reply overflow is described as a persistent error: replace with the first bullet of section 3.
- `docs/architecture/ghostty-resource-efficiency.md`, artifact size mentions if present: SIMD 1,074,998 to 1,075,756 bytes, scalar 1,015,961 to 1,016,721 bytes.
- `REVIEW_LEDGER.md` (the merger records this; this batch does not edit it): R076's closure text ("persistent visible error on queue overflow") no longer describes the behavior. Only a failed `pty_write` is persistent; overflow is a transient notice.

## 5. Checks run

Zig 0.16.0 (official aarch64-macos tarball, run from the session scratchpad; nothing installed in the repository). An unmodified-source build first reproduced the previous SIMD SHA-256 `2c8ce7de75f8c03037ba878b784520d19f941cb10f8f2a900e269e5fa9e8d5e0` exactly. The patched source was then built with `zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast` (SIMD) and the same with `-Dwasm-simd=false` (scalar). Final artifacts (after the P-01 rework): SIMD `6960a7749b74fb7511ae222ff77c409a03a50daa730c6c73ea86cd2e15f1e40b` (1075756 bytes); scalar `088ea2fea11c0753c4f30653446aa0676f24b8de2c0cbe6ddc6f4b5c4a3d7637` (1016721 bytes). `FORK.md` describes only the legacy fork artifact and is unchanged; `UPSTREAM.md` and `OarlockGhostty.ts` carry the sizes and hashes. The build's `zig-pkg`, `zig-out` and `.zig-cache` directories were deleted afterwards (an untracked `zig-pkg` fails `source-encoding.test.ts`).

- `bun run lint`: `Checked 1406 files in 621ms. No fixes applied.` and `Found 80 warnings.` (same count as before the batch)
- `bun run check-types`: `$ tsc --noEmit && tsc --noEmit -p scripts/tsconfig.json` (no errors)
- `bun run test`: `Test Files  643 passed (643)` and `Tests  6148 passed | 2 skipped (6150)` (rerun after the rework round) (includes `dist-budget.test.ts` and `source-encoding.test.ts`)
- `bun run soak:ghostty`: `Tests  4 passed (4)`
- `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`: `Finished dev profile [unoptimized + debuginfo] target(s) in 0.82s` (rerun after the rework), no warnings
- `cd src-tauri && cargo test --locked -- --test-threads=1` (nextest is not installed; the machine's real HOME did not trip the Git guard suites): `test result: ok. 1591 passed; 0 failed; 4 ignored` for the library and `ok` for every integration binary, `ghostty_artifacts` included (2 passed).
- `bun run size` fails on the base commit too; after the rework, against fe147a5 (total 13.84 kB over, terminal 97.99 kB, startup 256.69 kB, WebGL 16.57 kB, WASM 655.72 kB): total client JS 14.67 kB over its limit (+0.83 kB); primary terminal JS 98.66 kB gzip (+0.67 kB; limit 95.79 kB); startup 256.69 kB (unchanged); WebGL fallback 16.56 kB; WASM variants 656.13 kB gzip (+0.41 kB). The merger should raise the terminal and total allowances by about 0.7 kB and 0.9 kB, or accept the overshoot already present on the base.
- Em-dash gate: no U+2014 in this batch's diff (checked below the commit).
