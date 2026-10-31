import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));
vi.mock("@/modules/settings/preferences", () => ({ usePreferencesStore: {} }));
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({ toast: {} }));

import { useWorkspaceEnvStore } from "@/modules/workspace";
import { createDocumentIo } from "./useDocument";

const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
const host = { kind: "local" };

const themeFile =
  "C:\\Users\\me\\AppData\\Roaming\\consulting.quantumops.oarlock\\themes\\mine.oarlock-theme";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ kind: "text", content: "{}", size: 2, mtime: 1 });
  useWorkspaceEnvStore.setState({ env: ubuntu });
});

describe("the editor's document IO in a WSL window", () => {
  it("reads and conditionally saves a host file such as a theme on the host", async () => {
    const tauriDocumentIo = createDocumentIo(ubuntu);
    await tauriDocumentIo.read(themeFile, false);
    await tauriDocumentIo.write(themeFile, "{}", "baseline");
    expect(invoke.mock.calls).toEqual([
      [
        "fs_read_file",
        { path: themeFile, workspace: host, force: false, versioned: true },
      ],
      [
        "fs_save_document",
        {
          path: themeFile,
          content: "{}",
          workspace: host,
          expectedVersion: "baseline",
        },
      ],
    ]);
  });

  it("keeps a file inside the distro in the window's environment", async () => {
    const file = "/home/me/project/README.md";
    const tauriDocumentIo = createDocumentIo(ubuntu);
    await tauriDocumentIo.read(file, true);
    await tauriDocumentIo.write(file, "# Notes", "baseline");
    expect(invoke.mock.calls).toEqual([
      [
        "fs_read_file",
        { path: file, workspace: ubuntu, force: true, versioned: true },
      ],
      [
        "fs_save_document",
        {
          path: file,
          content: "# Notes",
          workspace: ubuntu,
          expectedVersion: "baseline",
        },
      ],
    ]);
  });
});
