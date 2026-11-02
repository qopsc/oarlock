import { serverForLanguage } from "@/modules/lsp/lib/presets";
import { expect, it } from "vitest";
import {
  documentLanguage,
  parseFiletype,
  vimFiletype,
} from "./documentLanguage";
import { resolveFormatter } from "./externalFormat";

it.each<[string, string | null]>([
  ["python", "py"],
  ["javascript", "js"],
  ["typescriptreact", "tsx"],
  ["xml", "xml"],
  ["rust", "rs"],
  ["", "txt"],
  ["null", "txt"],
  ["auto", null],
])("maps %s to its shared language id", (input, id) =>
  expect(parseFiletype(input)).toBe(id),
);
it("keeps an override through rename and resets to the new filename", () => {
  const override = parseFiletype("python");
  expect(documentLanguage("/repo/code.ts", override).id).toBe("py");
  expect(documentLanguage("/repo/renamed.rs", override).id).toBe("py");
  expect(documentLanguage("/repo/renamed.rs", parseFiletype("auto")).id).toBe(
    "rs",
  );
  expect(documentLanguage("/repo/renamed.rs", parseFiletype("")).id).toBeNull();
});
it("selects formatting and LSP from the same language as highlighting", () => {
  const selected = documentLanguage("/repo/code.txt", parseFiletype("python"));
  expect(selected.name).toBe("Python");
  expect(
    resolveFormatter(selected.id, {
      editorFormatter: "ruff",
      editorFormatterByLang: {},
    }),
  ).toBe("ruff");
  expect(serverForLanguage(selected.id, [], {})?.languages.py).toBe("python");
  expect(vimFiletype(selected.id)).toBe("python");
});
it("unknown filetypes fail without becoming an execution language", () => {
  expect(() => parseFiletype("../../other")).toThrow("Unknown filetype");
  expect(() => parseFiletype("py --exec")).toThrow("Unknown filetype");
});
it("shares filename rules including special filenames and aliases", () => {
  expect(documentLanguage("Dockerfile.web").id).toBe("dockerfile");
  expect(documentLanguage("/project/go.sum").id).not.toBe("go");
  expect(documentLanguage("/project/file.svg").id).toBe("xml");
});

it("retains custom LSP extension identities without loading a parser", () => {
  expect(documentLanguage("/repo/file.customlang").id).toBe("customlang");
  expect(documentLanguage("/repo/file.customlang", "txt").id).toBeNull();
  expect(documentLanguage("/repo/file.txt").id).toBeNull();
  expect(documentLanguage("/repo.with.dot/README").id).toBeNull();
});
