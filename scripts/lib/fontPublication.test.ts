import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fontAssetName, publishFonts } from "./fontPublication.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "font-publication-test-"));
  roots.push(root);
  const assets = join(root, "assets");
  const css = join(root, "fonts.css");
  await mkdir(assets);
  await writeFile(join(assets, "old.woff2"), "old font");
  await writeFile(join(assets, "LICENSE"), "old licence");
  await writeFile(css, "url('assets/old.woff2')", { mode: 0o640 });
  const bytes = new TextEncoder().encode("new font");
  const name = fontAssetName("new", bytes);
  return { assets, css, noticeName: "LICENSE", notice: "new licence", files: new Map([[name, bytes]]), stylesheet: name };
}

describe("font publication", () => {
  it("keeps the old selection and assets when publication is interrupted", async () => {
    const options = await fixture();
    await expect(publishFonts({ ...options, beforeCommit: async () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(await readFile(options.css, "utf8")).toBe("url('assets/old.woff2')");
    expect(await readFile(join(options.assets, "old.woff2"), "utf8")).toBe("old font");
    expect(await readFile(join(options.assets, "LICENSE"), "utf8")).toContain("old licence");
  });

  it("publishes prepared assets before the stylesheet and preserves its mode", async () => {
    const options = await fixture();
    await publishFonts({ ...options, beforeCommit: async () => {
      expect(await readFile(options.css, "utf8")).toBe("url('assets/old.woff2')");
      expect(await readFile(join(options.assets, options.stylesheet), "utf8")).toBe("new font");
    } });
    expect(await readFile(options.css, "utf8")).toBe(options.stylesheet);
    await expect(readFile(join(options.assets, "old.woff2"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(options.css)).mode & 0o777).toBe(0o640);
    expect(await readFile(join(options.assets, "LICENSE"), "utf8")).toContain("new licence");
  });

  it("refuses an existing asset with different content without changing the stylesheet", async () => {
    const options = await fixture();
    await writeFile(join(options.assets, options.stylesheet), "unexpected");
    await expect(publishFonts(options)).rejects.toThrow("does not match");
    expect(await readFile(options.css, "utf8")).toBe("url('assets/old.woff2')");
  });

  it.skipIf(process.platform !== "darwin")("preserves macOS extended attributes on the stylesheet", async () => {
    const options = await fixture();
    const set = spawnSync("xattr", ["-w", "com.oarlock.font-test", "test-value", options.css]);
    expect(set.status).toBe(0);
    await publishFonts(options);
    const get = spawnSync("xattr", ["-p", "com.oarlock.font-test", options.css], { encoding: "utf8" });
    expect(get.status).toBe(0);
    expect(get.stdout.trim()).toBe("test-value");
  });
});
