export type DropShell = "posix" | "fish" | "powershell" | "cmd";

/** Literal argument, at an unquoted argument boundary. Never guess from host OS. */
export function quoteShellPath(p: string, shell: DropShell): string {
  if (!p || /[\u0000-\u001f\u007f]/.test(p))
    throw new Error("Cannot insert a path containing control characters.");
  switch (shell) {
    case "posix":
      return `'${p.replace(/'/g, `'\\''`)}'`;
    case "fish":
      return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "powershell":
      return `'${p.replace(/'/g, "''")}'`;
    case "cmd":
      // Percent expansion and delayed ! expansion occur even inside quotes.
      // A literal double quote cannot occur in a Windows filename.
      if (/["%!]/.test(p))
        throw new Error(
          "This filename cannot be safely inserted into cmd.exe.",
        );
      return `"${p}"`;
    default:
      throw new Error("The terminal's shell is unknown.");
  }
}

export function formatDroppedPaths(
  paths: readonly string[],
  shell: DropShell,
): string {
  if (!paths.length) throw new Error("No paths to insert.");
  return `${paths.map((path) => quoteShellPath(path, shell)).join(" ")} `;
}
