# Vim and LazyVim compatibility checks

The built-in editor uses pinned local forks in `packages/codemirror-vim` and
`packages/codemirror-vim-core`. Their UPSTREAM.md files describe provenance,
asynchronous API changes, ownership and budgets. Commands are preserved rather
than redirected to the Find panel. This is still Vim emulation, not real Neovim.
LazyVim running in a terminal is tested separately through the terminal encoder.

Run from the repository root:

```sh
bun run test packages/codemirror-vim packages/codemirror-vim-core src/modules/editor/lib/vim.test.ts
bun run vite build --config scripts/vim-review/vite.config.ts
swiftc -module-cache-path /tmp/oarlock-vim-swift-cache scripts/terminal-search/host.swift -o /tmp/oarlock-vim-host
/tmp/oarlock-vim-host /tmp/oarlock-vim-probe "$PWD/src-tauri/tauri.conf.json" 650 500 40
```

The actual WKWebView fixture checks 27 cases: synchronous normal editing,
capture substitution, global deletion/nested substitution, pattern sort, search
addresses, counted/backward searches, operators, repetition, mapped macros,
public findKey callbacks, prompts and confirmations, ordered insert/Escape input,
undo grouping, jumplist navigation, visual search objects, macro recording and
external-edit cancellation. A hostile pattern reaches the production ten-second
deadline while the UI heartbeat continues; the next search succeeds. Console
plugin crashes fail the fixture. The native host checks the top-level result.
Review 103 adds configured block indent/unindent, explicit viewport alignment
after cursor motion, and valid-JavaScript block indentation. Review 104 adds
shared filetype/reset/rename behavior, structural XML tag objects, and an actual
React/CodeMirror mount that attaches, replaces and disables its parser.

For the upstream comparison, build and run both versions with the same harness:

```sh
VIM_CORPUS=1 VIM_BASELINE=1 VIM_OUTPUT=/tmp/oarlock-vim-baseline bun run vite build --config scripts/vim-review/vite.config.ts
/tmp/oarlock-vim-host /tmp/oarlock-vim-baseline "$PWD/src-tauri/tauri.conf.json" 650 500 150 > /tmp/oarlock-vim-baseline.log
VIM_CORPUS=1 VIM_OUTPUT=/tmp/oarlock-vim-corpus bun run vite build --config scripts/vim-review/vite.config.ts
/tmp/oarlock-vim-host /tmp/oarlock-vim-corpus "$PWD/src-tauri/tauri.conf.json" 650 500 150 > /tmp/oarlock-vim-corpus.log
bun scripts/vim-review/compare-corpus.mjs /tmp/oarlock-vim-baseline.log /tmp/oarlock-vim-corpus.log
```

`upstream-adapted.js` derives from the retained MIT-licensed core test corpus
(`packages/codemirror-vim-core/LICENSE`): command helpers and callbacks await
continuations. The harness supplies the CodeMirror 6 adapter and simulated text
input. Review 103 corrects the harness to match the app's highest-priority Vim
extension, multiple selections, Tab handling and XML stream parser. It measures
layout between simulated keys, fixes line metrics, allows one pixel of browser
rounding in scroll alignment, forwards static platform flags to the actual
adapter, and uses the platform's word-selection chord. The clipboard case awaits
selection cleanup between events rather than assuming several copies happen in
one synchronous task. No cases were removed.

A corpus result's `passed` means the run completed, not that all cases passed;
compare its failure list. On macOS arm64/WebKit, review 104 completes 715 cases,
with **709 baseline / 714 fork passing and no added failures**. The fixture now
loads the approved structural XML parser. The two filetype tests omit only the
obsolete CodeMirror 5 defineMode registration when running the CodeMirror 6
adapter; their assertions are retained. The remaining failure is a block-indent
expectation on malformed JavaScript (`1hello{`); valid JavaScript is separately
covered. This is not complete Vim parity. Review 103's 703/706 comparison remains
historical evidence with the previous token-only XML parser.

For the terminal path, use an existing LazyVim plugin installation:

```sh
python3 scripts/vim-review/lazyvim-probe.py --plugins "$HOME/.local/share/nvim/lazy"
```

The probe launches real Neovim in a PTY with temporary XDG config/data/state/cache,
reads already-installed plugins, and disables plugin installation/update checks
and automatic Treesitter installation. It does not load the user's init.lua.
The bridge runs Oarlock's actual Ghostty WASM model and keyboard encoder, including
terminal query replies. The test checks LazyVim startup, leader-ff picker, Escape,
insert/motions/ciw, `:%s`, and `:wq`, then verifies saved bytes. Review 102 passed
with Neovim 0.12.6 and installed LazyVim 16.0.1. Missing plugins are a fixture
prerequisite failure, not permission to install or alter the user's configuration.

These checks do not certify all LazyVim plugins/configurations, native app shortcut
interception, rendering, or Windows/Linux webviews. The WebKit fixtures use an
isolated nonpersistent view with the production CSP, not the complete Tauri app.
