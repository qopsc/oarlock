import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SearchFailure } from "./ExplorerSearch";

it("shows search admission failures instead of reporting no matches", () => {
  const html = renderToStaticMarkup(<SearchFailure error="Too many searches are active. Retry when one finishes." />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Too many searches are active");
  expect(html).not.toContain("No matches");
});
