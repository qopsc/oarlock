import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn(async () => ({ content: "result", size: 6 })),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { runExternalFormatter } from "./externalFormat";

it("retains the owning environment and passes filenames as data", async () => {
  for (const workspace of [
    { kind: "local" } as const,
    { kind: "wsl", distro: "Ubuntu" } as const,
  ]) {
    const path = "/project/it's a file; echo wrong.ts";
    await runExternalFormatter("prettier", path, "draft", "", workspace);
    expect(invoke).toHaveBeenLastCalledWith("fs_format_document", {
      formatter: "prettier",
      path,
      content: "draft",
      customCommand: "",
      workspace,
    });
  }
});
it("sends a selected language separately from the authorized document path", async () => {
  const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
  await runExternalFormatter(
    "prettier",
    "/repo/code.txt",
    "draft",
    "",
    workspace,
    "ts",
  );
  expect(invoke).toHaveBeenLastCalledWith("fs_format_document", {
    formatter: "prettier",
    path: "/repo/code.txt",
    content: "draft",
    customCommand: "",
    workspace,
    language: "ts",
  });
});
