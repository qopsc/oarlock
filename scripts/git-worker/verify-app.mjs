import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root, run, verify } from "./build.mjs";

// Check the final app, after Tauri signs it. Verifying the staging helper alone
// cannot detect a packager replacing its independent entitlements/signature.
if (process.platform !== "darwin") throw new Error("macOS bundle required");
const teamId = process.env.APPLE_TEAM_ID;
if (!/^[A-Z0-9]{10}$/.test(teamId ?? ""))
  throw new Error("APPLE_TEAM_ID required");
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass the built macos bundle directory");
const apps = readdirSync(directory).filter((name) => name.endsWith(".app"));
if (apps.length !== 1) throw new Error("Expected exactly one packaged app");
const app = join(directory, apps[0]);
const id = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
).identifier;
run("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  `-R=anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and identifier "${id}"`,
  app,
]);
verify(
  join(app, "Contents/XPCServices/OarlockGitWorker.xpc"),
  `${id}.git-worker`,
  teamId,
);
console.log(
  "Packaged app and independently sandboxed Git helper signatures verified.",
);
