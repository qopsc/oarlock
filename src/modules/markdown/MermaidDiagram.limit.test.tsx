import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MERMAID_MAX_TEXT } from "./mermaidRender";

vi.mock("@/modules/theme", () => ({
  useTheme: () => ({ activeTheme: {}, resolvedMode: "light" }),
  variantMode: () => "light",
}));
vi.mock("@streamdown/mermaid", () => ({
  createMermaidPlugin: () => ({ getMermaid: vi.fn() }),
}));

import { MermaidDiagram } from "./MermaidDiagram";

it("shows an oversized diagram state before attempting to render it", () => {
  const html = renderToStaticMarkup(
    <MermaidDiagram
      code={"x".repeat(MERMAID_MAX_TEXT + 1)}
      pending="Rendering"
      failed={(error) => <p>{(error as Error).message}</p>}
    />,
  );
  expect(html).toContain("Diagram too large to render.");
  expect(html).not.toContain("Rendering");
});
