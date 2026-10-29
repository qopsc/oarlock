# Theme storage regressions

Review 105 reproduced lost concurrent imports and a deleted theme returning when
another theme was saved. Review 106 moves both invariants into native tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked modules::themes
```

These use actual temporary files and concurrent threads sharing the production
transaction gate pattern. They also cover migration, malformed storage, validation,
failed writes and no-op revisions. The frontend suite checks native mutation
payloads, revision ordering, subscribe-before-read, late errors, cleanup and Retry:

```sh
bun run vitest run src/modules/theme/customThemes.test.ts src/modules/theme/themeDeletion.test.ts
```

The deliberately failing mock-store reproductions were removed after promoting
the invariants. Historical failing evidence: /tmp/oarlock-review105-theme-before.log.

The catalog uses the existing conditional writer and its 50 MiB limit. Windows
migration/saves currently fail safely because that writer remains unsupported
there; built-in themes remain available. Platform-specific tests still need native
Windows/Linux runs.
