import { describe, expect, it } from "vitest";
import { linuxInstallCommand } from "./linuxInstallCommand";

describe("Linux update commands", () => {
  it.each([
    ["debian", "x86_64", "sudo apt install ./Oarlock_1.2.3_amd64.deb"],
    ["debian", "aarch64", "sudo apt install ./Oarlock_1.2.3_arm64.deb"],
    ["fedora", "x86_64", "sudo dnf install ./Oarlock-1.2.3-1.x86_64.rpm"],
    ["fedora", "aarch64", "sudo dnf install ./Oarlock-1.2.3-1.aarch64.rpm"],
  ] as const)(
    "uses the %s package for %s",
    (distro, architecture, expected) => {
      expect(linuxInstallCommand(distro, "1.2.3", architecture)).toBe(expected);
    },
  );

  it("offers no command when architecture or version is unsafe or unknown", () => {
    expect(linuxInstallCommand("debian", "1.2.3", null)).toBeNull();
    expect(linuxInstallCommand("debian", "1.2.3", "riscv64")).toBeNull();
    expect(
      linuxInstallCommand("fedora", "1.2.3;touch BAD", "x86_64"),
    ).toBeNull();
  });
});
