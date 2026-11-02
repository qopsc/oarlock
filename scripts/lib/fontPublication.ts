import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Prepare replacements without removing anything referenced by the current CSS. */
export function fontAssetName(name: string, bytes: Uint8Array): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `${name}-${hash}.woff2`;
}

/** Replace a text file while retaining its access controls and extended attributes. */
async function replaceText(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, ".oarlock-font-publish-"));
  const candidate = join(scratch, basename(path));
  try {
    let existing = false;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`Cannot safely replace ${path}: expected a regular file`);
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      // BSD cp -p preserves ACLs and xattrs; GNU cp requires --preserve=all.
      const args = process.platform === "darwin" ? ["-p", path, candidate] : ["--preserve=all", path, candidate];
      const copied = spawnSync("cp", args, { encoding: "utf8" });
      if (copied.error || copied.status !== 0)
        throw new Error(`Cannot preserve metadata for ${path}: ${copied.error?.message || copied.stderr.trim()}`);
      const [original, staged] = await Promise.all([stat(path), stat(candidate)]);
      if (original.uid !== staged.uid || original.gid !== staged.gid || (original.mode & 0o7777) !== (staged.mode & 0o7777))
        throw new Error(`Cannot preserve ownership or permissions for ${path}`);
    }
    await writeFile(candidate, contents, existing ? undefined : { flag: "wx" });
    await rename(candidate, path);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function publishFonts(options: {
  assets: string;
  css: string;
  noticeName: string;
  notice: string;
  files: ReadonlyMap<string, Uint8Array>;
  stylesheet: string;
  beforeCommit?: () => Promise<void>;
}): Promise<void> {
  await mkdir(options.assets, { recursive: true });
  let oldStylesheet = "";
  try { oldStylesheet = await readFile(options.css, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const [name, bytes] of options.files) {
    const path = join(options.assets, name);
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await lstat(path)).isFile() || !Buffer.from(await readFile(path)).equals(Buffer.from(bytes)))
        throw new Error(`Existing font asset does not match ${path}`);
    }
  }
  const noticePath = join(options.assets, options.noticeName);
  let oldNotice = "";
  try { oldNotice = await readFile(noticePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Keep both notices across interruption if the font release changes.
  if (!oldNotice.includes(options.notice))
    await replaceText(noticePath, oldNotice ? `${oldNotice}\n\n${options.notice}` : options.notice);
  await options.beforeCommit?.();
  await replaceText(options.css, options.stylesheet);
  // Only retire fonts actually referenced by the old stylesheet, after its
  // replacement is visible. Never delete unrelated files in the asset folder.
  for (const match of oldStylesheet.matchAll(/url\(['"]?([^'"\)]+\.woff2)['"]?\)/g)) {
    const path = resolve(dirname(options.css), match[1]);
    if (dirname(path) !== resolve(options.assets) || options.files.has(basename(path))) continue;
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
