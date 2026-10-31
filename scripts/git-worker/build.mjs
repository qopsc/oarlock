import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const source = join(root, "src-tauri/git-worker");
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? (result.stderr ?? "") + (result.stdout ?? "")}`,
    );
  return result.stdout ?? "";
}
export function plist(values) {
  const escape = (v) =>
    String(v)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(
    values,
  )
    .map(
      ([k, v]) =>
        `<key>${escape(k)}</key>${
          typeof v === "string"
            ? `<string>${escape(v)}</string>`
            : `<dict>${Object.entries(v)
                .map(
                  ([a, b]) =>
                    `<key>${escape(a)}</key><string>${escape(b)}</string>`,
                )
                .join("")}</dict>`
        }`,
    )
    .join("")}</dict></plist>`;
}
export function sign(path, identity, entitlements) {
  const args = ["--force", "--sign", identity, "--options", "runtime"];
  if (identity !== "-") args.push("--timestamp");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(path);
  run("/usr/bin/codesign", args);
}
export function signingPolicy(env) {
  const identity = env.APPLE_SIGNING_IDENTITY?.trim() || "-";
  const distribution = env.OARLOCK_DISTRIBUTION_BUILD === "1";
  if (distribution && identity === "-")
    throw new Error(
      "Distribution Git helper requires APPLE_SIGNING_IDENTITY; local ad-hoc builds cannot be distributed",
    );
  if (identity !== "-" && !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID ?? ""))
    throw new Error("Signed helper requires APPLE_TEAM_ID");
  return { identity, teamId: env.APPLE_TEAM_ID };
}

export function build({
  output,
  appId,
  parentId = appId,
  arches,
  identity,
  teamId,
  testing = false,
}) {
  if (!/^[A-Za-z0-9.-]+$/.test(appId))
    throw new Error("Invalid app identifier");
  if (!arches.length || arches.some((a) => !["arm64", "x86_64"].includes(a)))
    throw new Error("Invalid macOS target architecture");
  if (!/^[A-Za-z0-9.-]+$/.test(parentId))
    throw new Error("Invalid parent identifier");
  if (
    testing &&
    (appId !== "consulting.quantumops.oarlock.dev.git-worker-tests" ||
      identity !== "-")
  )
    throw new Error(
      "Test peer policy is restricted to the isolated ad-hoc smoke bundle",
    );
  if (identity !== "-" && !/^[A-Z0-9]{10}$/.test(teamId ?? ""))
    throw new Error("Signed helper requires APPLE_TEAM_ID");
  // Ad-hoc development artifacts cannot authenticate an Apple signing team.
  // They deliberately refuse peers; only the isolated smoke fixture substitutes
  // a test identifier requirement to exercise XPC transport and sandboxing.
  const requirement = testing
    ? `identifier "${parentId}"`
    : identity === "-"
      ? "false"
      : `anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and identifier "${parentId}"`;
  const id = `${appId}.git-worker`;
  const bundle = join(output, "OarlockGitWorker.xpc");
  const bin = join(bundle, "Contents/MacOS/OarlockGitWorker");
  mkdirSync(dirname(bin), { recursive: true });
  const args = [
    "clang",
    "-fobjc-arc",
    "-fblocks",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-mmacosx-version-min=13.3",
    ...arches.flatMap((a) => ["-arch", a]),
    `-DOARLOCK_PARENT_REQUIREMENT=${JSON.stringify(requirement)}`,
    "-I",
    source,
    "-x",
    "objective-c",
    join(source, "service.m"),
    join(source, "apple_git.m"),
    join(source, "protocol.c"),
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-o",
    bin,
  ];
  run("/usr/bin/xcrun", args);
  writeFileSync(
    join(bundle, "Contents/Info.plist"),
    plist({
      CFBundleIdentifier: id,
      CFBundleExecutable: "OarlockGitWorker",
      CFBundleName: "OarlockGitWorker",
      CFBundleVersion: "1",
      CFBundlePackageType: "XPC!",
      LSMinimumSystemVersion: "13.3",
      XPCService: { ServiceType: "Application", RunLoopType: "dispatch_main" },
    }),
  );
  sign(bundle, identity, join(source, "entitlements.plist"));
  verify(bundle, id, identity === "-" ? undefined : teamId);
  return bundle;
}
export function verify(bundle, id, teamId) {
  const args = ["--verify", "--strict"];
  if (teamId) {
    if (!/^[A-Z0-9]{10}$/.test(teamId))
      throw new Error("Invalid Apple signing team");
    args.push(
      `-R=anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`,
    );
  }
  args.push(bundle);
  run("/usr/bin/codesign", args);
  const metadata = JSON.parse(
    run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(bundle, "Contents/Info.plist"),
    ]),
  );
  if (
    metadata.CFBundleIdentifier !== id ||
    metadata.CFBundlePackageType !== "XPC!"
  )
    throw new Error("Wrong Git helper bundle identity");
  const entitlements = run("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    bundle,
  ]);
  const parsed = JSON.parse(
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: entitlements,
    }),
  );
  if (
    Object.keys(parsed).length !== 1 ||
    parsed["com.apple.security.app-sandbox"] !== true
  )
    throw new Error(
      "Git helper must have its own sandbox entitlement and no ambient grants",
    );
}

if (import.meta.main) {
  if (process.platform !== "darwin") process.exit(0);
  const development =
    process.env.TAURI_ENV_DEBUG === "true" || process.argv.includes("--dev");
  const configured = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const overrides = JSON.parse(process.env.TAURI_CONFIG || "{}");
  const parentId = overrides.identifier || configured.identifier;
  const appId =
    development && parentId === "consulting.quantumops.oarlock"
      ? `${parentId}.dev`
      : parentId;
  const triple =
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    process.env.OARLOCK_CLI_TARGET ||
    `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  const arches =
    triple === "universal-apple-darwin"
      ? ["arm64", "x86_64"]
      : triple === "aarch64-apple-darwin"
        ? ["arm64"]
        : triple === "x86_64-apple-darwin"
          ? ["x86_64"]
          : [];
  const { identity, teamId } = signingPolicy(process.env);
  const output = join(root, "src-tauri/binaries/git-worker");
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(output, "build-"));
  try {
    const bundle = build({
      output: staging,
      appId,
      parentId,
      arches,
      identity,
      teamId,
    });
    const destination = join(output, "OarlockGitWorker.xpc");
    rmSync(destination, { recursive: true, force: true });
    cpSync(bundle, destination, { recursive: true });
    verify(
      destination,
      `${appId}.git-worker`,
      identity === "-" ? undefined : teamId,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
