import { expect, it, vi } from "vitest";
import { prepareShellPathDrop } from "./shellPathDrop";
import {
  captureTerminalNavigation,
  setTerminalLinkNavigation,
} from "./terminalLinkOpen";
import { TerminalRequestLifetime } from "./TerminalRequestLifetime";

it.each(["restart", "close", "navigation"])(
  "does not deliver a delayed drop after %s",
  async (reason) => {
    setTerminalLinkNavigation("a", 1);
    const navigation = captureTerminalNavigation();
    const lifetime = new TerminalRequestLifetime();
    let resolve!: (value: { shell: "posix"; paths: string[] }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{ shell: "posix"; paths: string[] }>((done) => {
          resolve = done;
        }),
    );
    const insert = vi.fn();
    const pending = prepareShellPathDrop(
      7,
      ["C:\\hello"],
      { kind: "local" },
      () => navigation() && !lifetime.signal.aborted,
      insert,
      prepare,
    );
    if (reason === "navigation") {
      setTerminalLinkNavigation("b", 2);
      setTerminalLinkNavigation("a", 1);
    } else lifetime.dispose();
    resolve({ shell: "posix", paths: ["/mnt/c/hello"] });
    await pending;
    expect(insert).not.toHaveBeenCalled();
  },
);
it("inserts converted paths with the native shell dialect and original source environment", async () => {
  const prepare = vi.fn(async () => ({
    shell: "posix" as const,
    paths: ["/mnt/c/it's$(whoami)"],
  }));
  const insert = vi.fn();
  await prepareShellPathDrop(
    42,
    ["C:\\it's$(whoami)"],
    { kind: "local" },
    () => true,
    insert,
    prepare,
  );
  expect(prepare).toHaveBeenCalledWith({
    id: 42,
    paths: ["C:\\it's$(whoami)"],
    source: { kind: "local" },
  });
  expect(insert).toHaveBeenCalledWith("'/mnt/c/it'\\''s$(whoami)' ");
});
it("rejects unsafe native results without a partial insertion", async () => {
  const insert = vi.fn();
  await expect(
    prepareShellPathDrop(
      42,
      ["/a"],
      { kind: "local" },
      () => true,
      insert,
      async () => ({ shell: "cmd", paths: ["C:\\safe", "C:\\%PATH%"] }),
    ),
  ).rejects.toThrow();
  expect(insert).not.toHaveBeenCalled();
});
