export type DistroKey = "debian" | "fedora";

/** Only offer commands for the architectures published by the release workflow. */
export function linuxInstallCommand(
  distro: DistroKey,
  version: string,
  architecture: string | null,
): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) return null;
  const deb =
    architecture === "x86_64"
      ? "amd64"
      : architecture === "aarch64"
        ? "arm64"
        : null;
  const rpm =
    architecture === "x86_64"
      ? "x86_64"
      : architecture === "aarch64"
        ? "aarch64"
        : null;
  if (!deb || !rpm) return null;
  return distro === "debian"
    ? `sudo apt install ./Oarlock_${version}_${deb}.deb`
    : `sudo dnf install ./Oarlock-${version}-1.${rpm}.rpm`;
}
