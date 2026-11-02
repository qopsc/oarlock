import { isWindowsPath } from "@/lib/windowsPath";
import { pathKey } from "@/lib/pathKey";

export function pathToFileUri(path: string): string {
  let p = isWindowsPath(path) ? path.replace(/\\/g, "/") : path;
  if (!p.startsWith("/")) p = `/${p}`;
  return `file://${p
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/%3A/g, ":").replace(/%2B/g, "+"),
    )
    .join("/")}`;
}

export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let encodedPath = uri.slice("file://".length);
  if (/^localhost\//i.test(encodedPath)) encodedPath = encodedPath.slice(9);
  if (!encodedPath.startsWith("/")) return null;
  let p: string;
  try {
    p = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  // Windows drive-letter URIs carry a leading slash (file:///C:/dir), and
  // servers spell the drive either way (pyright sends file:///d%3A/dir).
  if (/^\/[A-Za-z]:\//.test(p)) p = p[1].toUpperCase() + p.slice(2);
  return p;
}

/** Whether two URIs name the same file, whatever their encoding or drive case. */
export function sameFileUri(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = fileUriToPath(a);
  const pb = fileUriToPath(b);
  if (pa === null || pb === null) return false;
  const key = (path: string) =>
    isWindowsPath(path)
      ? pathKey(path)
      : path.length > 1
        ? path.replace(/\/+$/, "")
        : path;
  return key(pa) === key(pb);
}
