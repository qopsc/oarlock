# Oarlock Vim core fork

Pinned source: `@replit/codemirror-vim-core` **0.1.0**, published by
https://github.com/replit/codemirror-vim (MIT; see LICENSE).
`upstream/vim.js` and `upstream-tests/vim_test.js` retain the installed upstream
sources as compatibility baselines. They are development fixtures, never app imports.

Oarlock's `vim.js` preserves the command table, motions, operators, registers,
macros and Ex commands. Coroutine continuations suspend only at worker-backed
search operations and asynchronous command callbacks. Ordinary commands still
return synchronously. `resumable.js` checks command ownership before every resumed
step and reenters a CodeMirror operation for that step. The adapter provides input
ordering, cancellation and workers; the core has no DOM worker dependencies.

Regex search, search-based text objects, Ex address searches, global/vglobal,
pattern sorting, substitution and mapped/macro/repeated commands propagate the
continuations. Replacement expansion keeps upstream dollar/capture semantics with
an output budget before joining strings. Pattern and replacement limits are checked
before compilation/expansion. Global and pattern-sort ranges are checked before
building arrays. Search highlighting uses per-editor timers.

Compatibility corrections: mapped searches recorded inside a macro do not consume
that macro's interactive search-query queue; substitution's completion callback
fires once. No commands were intentionally disabled or redirected to another UI.
Visual-block indentation uses the configured indent width for spaces, rather
than the unrelated tab display width; tab-based indentation retains tabs.
This remains Vim emulation, with upstream's pre-existing limitations; it is not a
claim of complete Vim/Neovim feature parity.

On upgrade: retain new pristine sources, replay the focused changes, review every
user-pattern evaluation and asynchronous call site, run the ordinary frontend
suite, the actual-WebView command fixture, and the same adapted upstream corpus
against both versions. Do not accept added failures or mask them as baseline failures.

Review 104 adds `:set filetype&` / `:set ft&` reset through the adapter's automatic
language selection. Empty filetype remains explicit plain text; the document
bridge distinguishes that from reset. Ordinary filetype assignments keep the
existing Ex option dispatch.
