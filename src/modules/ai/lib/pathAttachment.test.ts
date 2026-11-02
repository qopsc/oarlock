import { beforeEach, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  env: { kind: "local" } as object,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => backend.env,
}));
import {
  attachmentName,
  readPickedFile,
  readDroppedFile,
  textTooLarge,
} from "./pathAttachment";
beforeEach(() => {
  backend.invoke.mockReset().mockResolvedValue({
    kind: "text",
    name: "a.md",
    content: "safe text",
    size: 9,
  });
  backend.env = { kind: "local" };
});
it.each([true, false])(
  "imports picked=%s through native validation instead of raw file reads",
  async (picked) => {
    await (picked ? readPickedFile : readDroppedFile)("/repo/a.md");
    expect(backend.invoke).toHaveBeenCalledExactlyOnceWith(
      "ai_import_attachment",
      { path: "/repo/a.md", workspace: { kind: "local" }, picked },
    );
  },
);
it.each([true, false])(
  "preserves the captured workspace for picked=%s",
  async (picked) => {
    backend.env = { kind: "wsl", distro: "Ubuntu" };
    const read = (picked ? readPickedFile : readDroppedFile)("/repo/a.md");
    backend.env = { kind: "wsl", distro: "Debian" };
    await read;
    expect(backend.invoke.mock.calls[0][1].workspace).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
  },
);
it("an explicit host picker environment overrides the selected WSL environment", async () => {
  backend.env = { kind: "wsl", distro: "Ubuntu" };
  await readPickedFile("C:/docs/a.txt", { kind: "local" });
  expect(backend.invoke.mock.calls[0][1].workspace).toEqual({ kind: "local" });
});
it("does not fall back to raw reads after native secret-path rejection", async () => {
  backend.invoke.mockRejectedValue(new Error("Refused: sensitive attachment"));
  await expect(readPickedFile("/repo/.env")).rejects.toThrow("sensitive");
  expect(backend.invoke).toHaveBeenCalledOnce();
});
it("labels paths across platforms and reports the shared text limit", () => {
  expect(attachmentName("C:\\repo\\a.txt")).toBe("a.txt");
  expect(attachmentName("/repo/a.txt")).toBe("a.txt");
  expect(textTooLarge(200001)).toContain("200 KB");
});
