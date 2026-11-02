import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The main webview's CSP decides which previews can load at all. Tauri's
// convertFileSrc returns asset://localhost/<path> on macOS and Linux but
// http://asset.localhost/<path> on Windows (no useHttpsScheme), so every
// directive that shows workspace files needs both.
const conf = JSON.parse(
  readFileSync(`${process.cwd()}/src-tauri/tauri.conf.json`, "utf8"),
) as { app: { security: { csp: string } } };

function sources(directive: string): string[] {
  for (const part of conf.app.security.csp.split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name === directive) return rest;
  }
  throw new Error(`no ${directive} directive`);
}

// Enough of CSP source matching for scheme-only and scheme://host sources.
function allows(directive: string, url: string): boolean {
  const target = new URL(url);
  return sources(directive).some((source) => {
    if (source.startsWith("'")) return false;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
      return target.protocol === source;
    }
    try {
      const allowed = new URL(source);
      return (
        allowed.protocol === target.protocol && allowed.host === target.host
      );
    } catch {
      return false;
    }
  });
}

// Every workspace file and font face loads through the backend's own scheme
// (asset_all_folders.rs): Tauri's asset protocol types files by extension (HTML for an
// unknown one), sends no sandbox or token, and the dialog plugin grants it every picked folder.
const guardedUrls = [
  `oarlock-asset://localhost/${encodeURIComponent("/home/me/pic.png")}`,
  `http://oarlock-asset.localhost/${encodeURIComponent("C:\\Users\\me\\pic.png")}`,
  `https://oarlock-asset.localhost/${encodeURIComponent("C:\\pic.png")}`,
];

describe("content security policy", () => {
  it.each(["img-src", "media-src", "font-src"])(
    "%s allows workspace files and fonts on every platform",
    (directive) => {
      for (const url of guardedUrls) {
        expect(allows(directive, url), url).toBe(true);
      }
    },
  );

  it("names no source of Tauri's asset protocol in any directive", () => {
    for (const directive of ["img-src", "media-src", "font-src", "frame-src"]) {
      for (const source of sources(directive)) {
        expect(source, directive).not.toMatch(/^(https?:\/\/)?asset(:|\.localhost)/);
      }
    }
    expect(allows("frame-src", "asset://localhost/x")).toBe(false);
  });

  // While "Allow the app to access all folders" is on, previews load through
  // the backend's own scheme (asset_all_folders.rs), which asks the setting on
  // every request.
  it.each(["img-src", "media-src", "frame-src"])(
    "%s allows previews from every folder on every platform",
    (directive) => {
      for (const url of [
        `oarlock-asset://localhost/${encodeURIComponent("/srv/pic.png")}`,
        `http://oarlock-asset.localhost/${encodeURIComponent("D:\\pic.png")}`,
        `https://oarlock-asset.localhost/${encodeURIComponent("D:\\pic.png")}`,
      ]) {
        expect(allows(directive, url), url).toBe(true);
      }
    },
  );

  // Markdown from the AI chat renders in this webview: a remote image URL
  // would leak data from a prompt-injected answer without a click.
  it("loads no remote images or media", () => {
    for (const directive of ["img-src", "media-src"]) {
      expect(allows(directive, "https://example.com/pixel.png")).toBe(false);
      expect(allows(directive, "http://example.com/pixel.png")).toBe(false);
    }
  });
});
