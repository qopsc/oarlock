# Browser preview lifetime regressions

The review 103 reproductions are now passing tests in the normal suite:

```sh
bun run vitest run src/modules/preview/PreviewAddressBar.lifetime.test.tsx src/modules/preview/lib/portProbe.test.ts
```

They exercise the real address bar with deferred requests and effect cleanup:
manual navigation, typing, visibility, reload, close and replacement invalidate
old requests. A 900 ms deadline aborts the fetch and response bodies are cancelled.
PreviewStack supplies active-space visibility and a space ownership key.
