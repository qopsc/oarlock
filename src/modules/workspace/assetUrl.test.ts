import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol = "asset") =>
    `http://${protocol}.localhost/${encodeURIComponent(path)}`,
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const { workspaceAssetUrl } = await import("./assetUrl");

type PageWindow = EventTarget & { __OARLOCK_NETWORK_PAGE__?: string };
const page = () => window as unknown as PageWindow;

beforeEach(() => {
  invoke.mockReset();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { __OARLOCK_NETWORK_PAGE__: "page-token" }),
  );
});

describe("workspaceAssetUrl", () => {
  it("converts a local path directly", async () => {
    expect(await workspaceAssetUrl("C:\\pics\\a.png", { kind: "local" })).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("C:\\pics\\a.png")}?access=0&t=page-token`,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps a WSL path to its host path first (crynta/terax-ai#1356)", async () => {
    invoke.mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.png");
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    expect(await workspaceAssetUrl("/home/me/a.png", workspace)).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.png")}?access=0&t=page-token`,
    );
    expect(invoke).toHaveBeenCalledWith("fs_host_path", {
      path: "/home/me/a.png",
      workspace,
    });
  });

  it("loads through the backend's own scheme while the app may access all folders", async () => {
    expect(
      await workspaceAssetUrl("D:\\photos\\a.png", { kind: "local" }, true),
    ).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("D:\\photos\\a.png")}?access=1&t=page-token`,
    );
    invoke.mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\srv\\a.png");
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    expect(await workspaceAssetUrl("/srv/a.png", workspace, true)).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("\\\\wsl.localhost\\Ubuntu\\srv\\a.png")}?access=1&t=page-token`,
    );
  });

  it("uses the guarded scheme for PDF previews in every workspace", async () => {
    expect(await workspaceAssetUrl("/repo/unsafe.PDF", { kind: "local" })).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("/repo/unsafe.PDF")}?access=0&t=page-token`,
    );
    invoke.mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\repo\\file.pdf");
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    expect(await workspaceAssetUrl("/repo/file.pdf", workspace)).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("\\\\wsl.localhost\\Ubuntu\\repo\\file.pdf")}?access=0&t=page-token`,
    );
  });

  it("waits for the page generation native delivers, and carries it in the URL", async () => {
    delete page().__OARLOCK_NETWORK_PAGE__;
    const url = workspaceAssetUrl("/repo/a.png", { kind: "local" });
    let settled = false;
    void url.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    page().__OARLOCK_NETWORK_PAGE__ = "late-token";
    page().dispatchEvent(new Event("oarlock:network-page"));
    expect(await url).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("/repo/a.png")}?access=0&t=late-token`,
    );
  });
});
