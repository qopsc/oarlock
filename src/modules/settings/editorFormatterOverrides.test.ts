import { expect, it, vi } from "vitest";

const mutate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./nativePreferences", () => ({ mutatePreferences: mutate }));

import { patchEditorFormatterByLang } from "./store";

it("sends only the requested formatter fields, including atomic renames", async () => {
  await patchEditorFormatterByLang({ rust: "lsp" });
  await patchEditorFormatterByLang({ rust: null, python: "custom" });
  expect(mutate).toHaveBeenNthCalledWith(1, {
    kind: "patch", key: "editorFormatterByLang", values: { rust: "lsp" },
  });
  expect(mutate).toHaveBeenNthCalledWith(2, {
    kind: "patch", key: "editorFormatterByLang", values: { rust: null, python: "custom" },
  });
});
