import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
import type { PtySession } from "./pty-bridge";
import { cachedShellDialect } from "./shellDialectCache";
import { launchShellDrop } from "./shellDropLauncher";
import { planShellDrop, runShellDrop, type ShellDropRun } from "./shellPathDrop";

const local: WorkspaceEnv = { kind: "local" };
const ubuntu: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
const debian: WorkspaceEnv = { kind: "wsl", distro: "Debian" };

describe("planShellDrop", () => {
  it.each([
    ["posix", "'/a b/it'\\''s' '/c$(x)' "],
    ["fish", "'/a b/it\\'s' '/c$(x)' "],
    ["powershell", "'/a b/it''s' '/c$(x)' "],
  ] as const)("quotes for %s", (dialect, expected) => {
    expect(planShellDrop(["/a b/it's", "/c$(x)"], local, local, dialect, false)).toBe(expected);
  });

  it("quotes for cmd and refuses what cmd expands", () => {
    expect(planShellDrop(["C:\\a b\\c"], local, local, "cmd", true)).toBe('"C:\\a b\\c" ');
    for (const bad of ['C:\\100%', "C:\\a!b", 'C:\\a"b'])
      expect(() => planShellDrop([bad], local, local, "cmd", true)).toThrow();
  });

  it("refuses control characters, bad counts, sizes and relative paths", () => {
    const refuse = (paths: string[]) =>
      expect(() => planShellDrop(paths, local, local, "posix", false)).toThrow();
    refuse(["/a\nb"]);
    refuse([]);
    refuse(Array.from({ length: 257 }, () => "/a"));
    refuse([`/${"a".repeat(64 * 1024)}`]);
    refuse(["relative/path"]);
  });

  it("uses forward slashes for a POSIX shell on Windows", () => {
    expect(planShellDrop(["C:\\Users\\me\\f.txt"], local, local, "posix", true)).toBe(
      "'C:/Users/me/f.txt' ",
    );
    expect(planShellDrop(["C:\\Users\\me\\f.txt"], local, local, "powershell", true)).toBe(
      "'C:\\Users\\me\\f.txt' ",
    );
  });

  it("maps host drive paths into a WSL terminal and keeps same-distro paths", () => {
    expect(planShellDrop(["C:\\Users\\me\\f g"], local, ubuntu, "posix", true)).toBe(
      "'/mnt/c/Users/me/f g' ",
    );
    expect(planShellDrop(["/home/me/f"], ubuntu, ubuntu, "posix", true)).toBe("'/home/me/f' ");
  });

  it("refuses paths that have no equivalent in the terminal's environment", () => {
    expect(() => planShellDrop(["\\\\server\\share\\f"], local, ubuntu, "posix", true)).toThrow();
    expect(() => planShellDrop(["/mnt/c/x"], local, ubuntu, "posix", true)).toThrow();
    expect(() => planShellDrop(["/home/me/f"], ubuntu, local, "posix", true)).toThrow();
    expect(() => planShellDrop(["/home/me/f"], ubuntu, debian, "posix", true)).toThrow();
  });
});

function harness(overrides: Partial<ShellDropRun> = {}) {
  const sent: string[] = [];
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
    sent.push(new TextDecoder().decode(bytes));
  }, close: async () => {}, resize: async () => {} } as PtySession);
  const finish = writer.reserveInput();
  if (!finish) throw new Error("no slot");
  const refuse = vi.fn();
  const paste = vi.fn((text: string) => {
    writer.enqueue(new TextEncoder().encode(text));
  });
  const run: ShellDropRun = {
    paths: ["/a b"],
    source: local,
    target: local,
    windows: false,
    finish,
    atPrompt: async () => true,
    dialect: async () => "posix",
    promptConfirmed: () => true,
    active: () => true,
    running: () => false,
    paste,
    refuse,
    ...overrides,
  };
  return { run, sent, writer, refuse, paste };
}
const typeAfter = async (h: ReturnType<typeof harness>, text: string) => {
  h.writer.enqueue(new TextEncoder().encode(text));
  await vi.waitFor(() => expect(h.sent).toContain(text));
};

describe("runShellDrop", () => {
  it("pastes the quoted paths once, ahead of keys typed meanwhile", async () => {
    let release!: () => void;
    const h = harness({ atPrompt: () => new Promise((resolve) => { release = () => resolve(true); }) });
    const done = runShellDrop(h.run);
    h.writer.enqueue(new TextEncoder().encode("k"));
    expect(h.sent).toEqual([]);
    release();
    await done;
    await vi.waitFor(() => expect(h.sent.join("")).toBe("'/a b' k"));
    expect(h.paste).toHaveBeenCalledTimes(1);
    h.writer.dispose();
  });

  it("waits for a pending clipboard paste reserved before the drop", async () => {
    const sent: string[] = [];
    const writer = new BoundedPtyWriter((error) => { throw error; });
    writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
      sent.push(new TextDecoder().decode(bytes));
    }, close: async () => {}, resize: async () => {} } as PtySession);
    const clipboard = writer.reserveInput();
    const finish = writer.reserveInput();
    if (!clipboard || !finish) throw new Error("no slot");
    await runShellDrop({
      paths: ["/x"], source: local, target: local, windows: false, finish,
      atPrompt: async () => true, dialect: async () => "posix",
      promptConfirmed: () => true, active: () => true, running: () => false,
      paste: (text) => { writer.enqueue(new TextEncoder().encode(text)); },
      refuse: () => {},
    });
    expect(sent).toEqual([]);
    clipboard(() => { writer.enqueue(new TextEncoder().encode("clip")); });
    await vi.waitFor(() => expect(sent).toEqual(["clip", "'/x' "]));
    writer.dispose();
  });

  it.each([
    ["a running program", async () => false, "A program is running"],
    ["an unverifiable foreground", async () => null, "Could not verify"],
  ])("refuses with %s and frees the slot", async (_name, atPrompt, text) => {
    const h = harness({ atPrompt });
    await runShellDrop(h.run);
    expect(h.refuse).toHaveBeenCalledWith(expect.stringContaining(text));
    expect(h.paste).not.toHaveBeenCalled();
    await typeAfter(h, "k");
    h.writer.dispose();
  });

  it("refuses an unrecognized shell", async () => {
    const h = harness({ dialect: async () => null });
    await runShellDrop(h.run);
    expect(h.refuse).toHaveBeenCalledOnce();
    await typeAfter(h, "k");
    h.writer.dispose();
  });

  it("frees the slot when the dialect lookup rejects or the check throws", async () => {
    for (const overrides of [
      { dialect: async () => { throw new Error("ipc down"); } },
      { atPrompt: () => { throw new Error("sync failure"); } },
    ] as Partial<ShellDropRun>[]) {
      const h = harness(overrides);
      await runShellDrop(h.run);
      expect(h.refuse).toHaveBeenCalledOnce();
      await typeAfter(h, "k");
      h.writer.dispose();
    }
  });

  it("frees the slot when the drop code fails to load", async () => {
    const h = harness();
    launchShellDrop(h.run, () => Promise.reject(new Error("chunk failed")));
    await typeAfter(h, "k");
    expect(h.refuse).toHaveBeenCalledWith(expect.stringContaining("chunk failed"));
    h.writer.dispose();
  });

  it("does not insert when the terminal changed or a command started meanwhile", async () => {
    for (const overrides of [{ active: () => false }, { running: () => true }]) {
      const h = harness(overrides);
      await runShellDrop(h.run);
      expect(h.paste).not.toHaveBeenCalled();
      expect(h.refuse).toHaveBeenCalledOnce();
      await typeAfter(h, "k");
      h.writer.dispose();
    }
  });

  it("takes a WSL drop only after shell integration reported a prompt", async () => {
    const without = harness({ target: ubuntu, source: ubuntu, promptConfirmed: () => false });
    await runShellDrop(without.run);
    expect(without.paste).not.toHaveBeenCalled();
    expect(without.refuse).toHaveBeenCalledWith(expect.stringContaining("WSL"));
    await typeAfter(without, "k");
    without.writer.dispose();
    const confirmed = harness({ target: ubuntu, source: ubuntu, promptConfirmed: () => true });
    await runShellDrop(confirmed.run);
    expect(confirmed.paste).toHaveBeenCalledOnce();
    confirmed.writer.dispose();
  });

  it("refuses a WSL drop when the prompt is lost before delivery", async () => {
    let confirmed = true;
    const h = harness({
      target: ubuntu,
      source: ubuntu,
      promptConfirmed: () => confirmed,
      atPrompt: async () => {
        confirmed = false;
        return true;
      },
    });
    await runShellDrop(h.run);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.refuse).toHaveBeenCalledOnce();
    await typeAfter(h, "k");
    h.writer.dispose();
  });

  it("inserts at the command bar without asking about the foreground", async () => {
    const atPrompt = vi.fn(async () => true);
    const insert = vi.fn(() => true);
    const h = harness({ atPrompt, paste: insert });
    await runShellDrop(h.run);
    expect(insert).toHaveBeenCalledWith("'/a b' ");
    h.writer.dispose();
  });
});

describe("cachedShellDialect", () => {
  type Pty = { id: number };
  const session = (pty: Pty | null) => ({
    pty,
    dialect: null as { pty: Pty; value: "posix" | "fish" | null } | null,
  });

  it("asks once per pty and again for a new shell", async () => {
    const first = { id: 1 };
    const second = { id: 2 };
    const s = session(first);
    const fetch = vi.fn(async () => "posix" as const);
    await cachedShellDialect(s, first, fetch);
    await cachedShellDialect(s, first, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    s.pty = second;
    const fish = vi.fn(async () => "fish" as const);
    expect(await cachedShellDialect(s, second, fish)).toBe("fish");
    expect(s.dialect).toEqual({ pty: second, value: "fish" });
  });

  it("does not store a reply that lands after the pty was replaced", async () => {
    const old = { id: 1 };
    const next = { id: 2 };
    const s = session(old);
    let reply!: (value: "posix") => void;
    const pending = cachedShellDialect(s, old, () => new Promise((resolve) => { reply = resolve; }));
    s.pty = next;
    reply("posix");
    await pending;
    expect(s.dialect).toBeNull();
  });
});
