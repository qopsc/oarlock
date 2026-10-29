# Sandboxed Git worker (macOS)

This is the authenticated XPC bootstrap for the isolated Git execution boundary.
**It does not execute Git or authorize publication yet.** A successful capability
probe returns `executionReady: false` and `candidate_execution_unavailable`.
The current live Git runner is not routed through it; its running-metadata race
remains a release blocker (AGENTS.md, Reviews 67–69).

The main app stays unsandboxed. `OarlockGitWorker.xpc` has its own signature and
only the App Sandbox entitlement. It is embedded in `Contents/XPCServices` and
launched by macOS on demand. No startup probe, persistent timer, network grant,
keychain group, inherited filesystem grant or writable live-repository descriptor
is installed. The bootstrap protocol accepts only version, nonce and operation
(`capabilities`); it refuses execution requests and extra fields.

Production authentication is mutual. The helper admits only the configured parent
identifier signed by the configured Apple team. The client verifies the installed
helper's sealed resources, exact entitlement set and the running host's signing
team, then installs its code requirement on XPC. XPC checks peer requirements on
messages. The helper also checks its own sandbox entitlement and verifies it can
read, but cannot open for writing, its signed Info.plist. This runtime probe is
only bootstrap evidence, not proof that candidate Git/hooks work.

## Building and checking

`bun scripts/git-worker/build.mjs` runs from Tauri's `beforeBundleCommand`.
Release builds require `APPLE_SIGNING_IDENTITY` already imported in the signing
keychain and `APPLE_TEAM_ID`. CI imports the identity before bundling and verifies
the final packaged app/helper afterward with `scripts/git-worker/verify-app.mjs`.
It checks independent helper entitlements after outer-app signing. This check
runs after the Tauri action creates draft assets; a failure fails the release job.

A local debug package (`bun run tauri bundle --debug`) can build an ad-hoc helper.
Its service/container ID has the isolated development suffix. Ad-hoc development
helpers deliberately refuse peers; the production client has no ad-hoc trust
fallback. A certificate-signed development bundle can use mutual team trust.
`bun scripts/git-worker/build.mjs --dev` builds just the development helper.
`OARLOCK_CLI_TARGET=universal-apple-darwin` builds both Mac architectures.

`bun scripts/git-worker/smoke.mjs` needs macOS and Xcode command-line tools. It
builds a disposable test app with a fixed, separate `.dev.git-worker-tests`
identity. Only that fixture enables an identifier-based ad-hoc test policy; it
cannot validate Apple's release certificate chain. The production-compiled client
is also tested to reject ad-hoc authentication. Smoke tests cover actual XPC
activation, malformed protocol requests, confinement, tampered resources, wrong
peer identity, missing/extra entitlements and default ad-hoc refusal. Successful
tests remove their temporary app; a failure prints its retained diagnostic path.
macOS may retain the test service's isolated, empty sandbox container.

## Remaining boundary work

Candidate input admission, private workspace execution, descendant ownership,
explicit refusal of executable extensions, bounded result manifests and the native
journaled publisher still need implementation and adversarial tests. The release policy now refuses actions requiring executable hooks, filters or
external helpers: a detached child can survive process-group cleanup and alter
another candidate in the same XPC container. A future design allowing such code
would need stronger isolation and independent hook supervision. Never turn a capability probe into an execution permit or add an
unrestricted fallback. Linux and Windows need separately validated adapters.

Review 70 adds candidate config admission, index validation and a single-index
publication primitive under `src/modules/git`. They are not wired into this
bootstrap; verified object transfer and the operation coordinator remain pending.
The direct Apple Git binary passed a real XPC init/add/commit probe, while the
`/usr/bin/git` xcrun launcher failed in App Sandbox. The approved installation policy is verified Apple Git. The resolver now checks
the fixed Command Line Tools location first, then the default Xcode location;
it never consults PATH or DEVELOPER_DIR and never runs xcrun. It requires the
Apple `com.apple.git` signature, library validation, and a root-owned regular
executable reached through root-owned directories with no group/other write
permissions, special privilege bits, symlinks or extended ACLs. An unreadable ACL
is a failure; explicit absence is read through filesec metadata. A signed copy in
a user-writable directory does not qualify. Some standard Xcode installations
under group-writable /Applications therefore do not qualify; installing Apple's
Command Line Tools provides the protected location without changing permissions.

Protocol version 2 reports `gitVerified` separately from `executionReady`. The
native capability response provides installation/repair guidance when Apple Git
is unavailable or cannot be verified. Verification does not launch Git and does
not enable candidate execution. The actual launch/version check and full operation
coordinator remain pending. Terminal Git selection is unaffected.
