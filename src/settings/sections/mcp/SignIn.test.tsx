import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

import type { AuthStatus } from "@/modules/mcp/lib/auth";
import { SignInRow } from "./SignIn";

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    serverId: "s1",
    state: "none",
    reason: null,
    requiredScope: null,
    scope: null,
    issuer: null,
    expiresAtMs: null,
    canRefresh: false,
    signingIn: false,
    ...overrides,
  };
}

function render(value: AuthStatus | undefined, error?: string): string {
  return renderToStaticMarkup(
    <SignInRow
      status={value}
      error={error}
      onSignIn={() => {}}
      onSignOut={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe("SignInRow", () => {
  it("offers an explicit retry for discovery failure without relabelling sign-in", () => {
    const html = renderToStaticMarkup(
      <SignInRow
        status={status()}
        error={undefined}
        discoveryError="HTTP 503"
        onRetryDiscovery={() => {}}
        onSignIn={() => {}}
        onSignOut={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Sign-in discovery failed: HTTP 503");
    expect(html).toContain("Retry discovery");
    expect(html).not.toContain("Sign in required");
  });
  it("offers sign-in when the server asks for it", () => {
    const html = render(status({ state: "required", reason: "unauthorized" }));
    expect(html).toContain("Sign in required");
    expect(html).toContain(">Sign in<");
    expect(html).not.toContain("Sign out");
  });

  it("offers sign-out, and signing in again, once signed in", () => {
    const html = render(
      status({ state: "signed-in", issuer: "https://auth.example.com" }),
    );
    expect(html).toContain("Signed in with auth.example.com");
    expect(html).toContain("Sign out");
    expect(html).toContain("Sign in again");
  });

  it("lets a sign-in in progress be cancelled, and shows why one failed", () => {
    const html = render(
      status({ state: "required", signingIn: true }),
      "mcp: sign-in timed out; start it again",
    );
    expect(html).toContain("Cancel");
    expect(html).not.toContain(">Sign in<");
    expect(html).toContain("sign-in timed out");
  });

  it("says plainly where the tokens are kept", () => {
    expect(render(undefined)).toContain("system keychain");
  });

  it("shows the commit phase without offering cancellation or another sign-in", () => {
    const html = render(status({ signingIn: true, saving: true }));
    expect(html).toContain("Saving sign-in…");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain(">Sign in<");
  });
});
