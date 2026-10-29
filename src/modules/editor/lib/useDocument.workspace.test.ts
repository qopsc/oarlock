import { expect, it, vi } from "vitest";
import { DocumentSession } from "./documentSession";
import { createDocumentIo } from "./useDocument";
import { useWorkspaceEnvStore } from "@/modules/workspace/env";

const calls = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => calls);
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("@/modules/mac-privacy", () => ({
  dismissFileError: vi.fn(),
  showFileError: vi.fn(),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({}) },
}));
vi.mock("@/modules/workspace", async () => import("@/modules/workspace/env"));
vi.mock("@/modules/workspace/authorize", () => ({
  authorizationSettled: async () => {},
}));

it("keeps a pending document save in the distro where it was opened", async () => {
  const original = { kind: "wsl" as const, distro: "Ubuntu" };
  useWorkspaceEnvStore.getState().setEnv(original);
  calls.invoke.mockImplementation(async (command: string) => {
    if (command === "fs_read_file")
      return {
        kind: "text",
        content: "original",
        size: 8,
        mtime: 1,
        version: "baseline",
      };
    return { kind: "saved", version: "new" };
  });
  const session = new DocumentSession(createDocumentIo(original), {
    state: vi.fn(),
    dirty: vi.fn(),
    saved: vi.fn(),
    saveFailed: vi.fn(),
    conflict: vi.fn(),
    released: vi.fn(),
    autoSave: () => ({ enabled: false, delay: 0 }),
  });
  session.open("/home/me/project/file.txt");
  await vi.waitFor(() => expect(session.text()).toBe("original"));
  session.change("unsaved Ubuntu changes");
  useWorkspaceEnvStore.getState().setEnv({ kind: "wsl", distro: "Debian" });
  expect(await session.save()).toBe(true);
  expect(calls.invoke).toHaveBeenCalledWith(
    "fs_save_document",
    expect.objectContaining({ workspace: original }),
  );
  session.close();
});

it("pending recovery keeps its owning environment after the current space changes", async () => {
  const { recoveryMutationCoverage, recoveryTargetsChanged } = await import(
    "./recoveryTarget"
  );
  const { workspaceScopeKey } = await import("@/modules/workspace/env");
  const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
  const debian = { kind: "wsl", distro: "Debian" } as const;
  calls.invoke.mockImplementation(async (command: string) =>
    command === "fs_recovery_begin" ? "test-handle" : false,
  );
  recoveryMutationCoverage(true);
  const target =
    await createDocumentIo(ubuntu).observeRecovery?.("/home/me/file");
  if (!target) throw new Error("Missing recovery observation");
  try {
    useWorkspaceEnvStore.getState().setEnv(debian);
    recoveryTargetsChanged(workspaceScopeKey(debian), ["/home/me"]);
    expect(await target.changed()).toBe(false);
    recoveryTargetsChanged(workspaceScopeKey(ubuntu), ["/home/me"]);
    expect(await target.changed()).toBe(true);
  } finally {
    target.dispose();
    recoveryMutationCoverage(false);
  }
});
it("a host Save As destination in a WSL-owned editor observes host mutations", async () => {
  const { recoveryMutationCoverage, recoveryTargetsChanged } = await import(
    "./recoveryTarget"
  );
  const { workspaceScopeKey } = await import("@/modules/workspace/env");
  const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
  calls.invoke.mockImplementation(async (command: string) =>
    command === "fs_recovery_begin" ? "test-handle" : false,
  );
  recoveryMutationCoverage(true);
  const target =
    await createDocumentIo(ubuntu).observeRecovery?.("C:\\work\\file.txt");
  if (!target) throw new Error("Missing recovery observation");
  try {
    recoveryTargetsChanged(workspaceScopeKey(ubuntu), ["C:/work"]);
    expect(await target.changed()).toBe(false);
    recoveryTargetsChanged(workspaceScopeKey({ kind: "local" }), ["C:/work"]);
    expect(await target.changed()).toBe(true);
  } finally {
    target.dispose();
    recoveryMutationCoverage(false);
  }
});
