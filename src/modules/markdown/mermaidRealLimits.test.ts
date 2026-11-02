import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { diagramLimitError, mermaidConfig, MERMAID_MAX_EDGES } from "./mermaidRender";

it("enforces the edge limit in the installed Mermaid parser", async () => {
  const plugin = createRequire(fileURLToPath(import.meta.resolve("@streamdown/mermaid")));
  const { default: mermaid } = await import(pathToFileURL(plugin.resolve("mermaid")).href);
  mermaid.initialize(mermaidConfig("light"));
  const source = `flowchart TD\n${Array.from(
    { length: MERMAID_MAX_EDGES + 1 },
    (_, i) => `A${i} --> A${i + 1}`,
  ).join("\n")}`;
  const error = await mermaid.parse(source).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(diagramLimitError(error)).toEqual(new Error("Diagram too large to render."));
});
