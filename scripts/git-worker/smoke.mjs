import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { build, run, sign, verify, plist, source } from "./build.mjs";
if (process.platform !== "darwin") process.exit(0);
const folder = mkdtempSync(join(tmpdir(), "oarlock-xpc-test-"));
const appId = "consulting.quantumops.oarlock.dev.git-worker-tests";
const app = join(folder, "GitWorkerTests.app");
const executable = join(app, "Contents/MacOS/GitWorkerTests");
let passed = false;
try {
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  const helper = build({
    output: folder,
    appId,
    arches: [process.arch === "arm64" ? "arm64" : "x86_64"],
    identity: "-",
    testing: true,
  });
  const embedded = join(app, "Contents/XPCServices/OarlockGitWorker.xpc");
  cpSync(helper, embedded, { recursive: true });
  writeFileSync(
    join(app, "Contents/Info.plist"),
    plist({
      CFBundleIdentifier: appId,
      CFBundleExecutable: "GitWorkerTests",
      CFBundleName: "GitWorkerTests",
      CFBundleVersion: "1",
      CFBundlePackageType: "APPL",
    }),
  );
  const clientArgs = [
    "clang",
    "-DOARLOCK_TESTING=1",
    "-fobjc-arc",
    "-fblocks",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-mmacosx-version-min=13.3",
    "-I",
    source,
    "-x",
    "objective-c",
    join(source, "smoke.m"),
    join(source, "client.m"),
    join(source, "apple_git.m"),
    join(source, "protocol.c"),
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-o",
    executable,
  ];
  run("/usr/bin/xcrun", clientArgs);
  sign(app, "-");
  verify(embedded, `${appId}.git-worker`);
  run(executable, ["--protocol"]);
  console.log(run(executable, ["--apple-git"]).trim());
  console.log(run(executable, []).trim());
  function refused(reason) {
    const result = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.connected, false);
    if (reason) assert.equal(reply.detail, reason);
  }
  function install(options) {
    rmSync(embedded, { recursive: true, force: true });
    const replacement = build({
      output: folder,
      appId,
      arches: [process.arch === "arm64" ? "arm64" : "x86_64"],
      identity: "-",
      testing: true,
      ...options,
    });
    cpSync(replacement, embedded, { recursive: true });
    sign(app, "-");
  }
  // Changing a sealed bundle resource must be caught before opening XPC.
  appendFileSync(join(embedded, "Contents/Info.plist"), "\n");
  refused("helper_unavailable");
  install({});
  run(executable, []);
  // A valid sandboxed helper still refuses a caller with the wrong identity.
  install({ parentId: `${appId}.wrong-parent` });
  refused("helper_connection_failed");
  install({});
  run(executable, []);
  // A helper with the host's (empty) entitlements must never be accepted.
  const emptyEntitlements = join(folder, "empty.plist");
  writeFileSync(emptyEntitlements, plist({}));
  sign(embedded, "-", emptyEntitlements);
  sign(app, "-");
  assert.throws(() => verify(embedded, `${appId}.git-worker`));
  refused("helper_unavailable");
  // Extra ambient grants invalidate the boundary even with App Sandbox enabled.
  writeFileSync(
    emptyEntitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.client</key><true/></dict></plist>',
  );
  sign(embedded, "-", emptyEntitlements);
  sign(app, "-");
  assert.throws(() => verify(embedded, `${appId}.git-worker`));
  refused("helper_unavailable");
  // Ordinary ad-hoc builds use a deny-all policy, never the test exception.
  install({ testing: false });
  refused("helper_connection_failed");
  assert.throws(() =>
    build({
      output: folder,
      appId: "consulting.quantumops.oarlock",
      arches: ["arm64"],
      identity: "-",
      testing: true,
    }),
  );
  install({});
  run(executable, []);
  // A client compiled for production has no ad-hoc authentication exception.
  run(
    "/usr/bin/xcrun",
    clientArgs.filter((arg) => arg !== "-DOARLOCK_TESTING=1"),
  );
  sign(app, "-");
  refused("helper_unavailable");
  passed = true;
  console.log(
    "Protocol, XPC activation, sandbox, sealed-resource, peer-identity, missing-entitlement and ad-hoc-policy checks passed.",
  );
} finally {
  if (passed) rmSync(folder, { recursive: true, force: true });
  else console.error(`Preserved failed smoke bundle: ${folder}`);
}
