/** A path that starts at a drive letter (`C:\dir`, `C:/dir`). */
export function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/** A path that starts at a network share (`\\server\share`). */
export function isWindowsUncPath(path: string): boolean {
  return path.startsWith("\\\\");
}

/** A Windows path of either kind, which is absolute and uses backslashes or slashes. */
export function isWindowsPath(path: string): boolean {
  return isWindowsDrivePath(path) || isWindowsUncPath(path);
}
