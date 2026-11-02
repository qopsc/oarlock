import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CompletionOwner } from "./safePathCompletion";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { ownedPathCompletion } from "./ownedPathCompletion";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function setup(text = "cat fi") {
  const state = EditorState.create({ doc: text, selection: { anchor: text.length } });
  const view = { state, dispatch: vi.fn() };
  const ctx = new CompletionContext(state, text.length, true, view as unknown as EditorView);
  let active = true;
  const owner: CompletionOwner = {
    cwd: "/repo", workspace: { kind: "wsl", distro: "Ubuntu" },
    active: () => active, verify: vi.fn().mockResolvedValue("posix"),
  };
  return { state, view, ctx, owner, invalidate: () => { active = false; } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function apply(option: NonNullable<Awaited<ReturnType<typeof ownedPathCompletion>>>["options"][number], view: ReturnType<typeof setup>["view"], from: number, to: number) {
  if (typeof option.apply !== "function") throw Error("Expected guarded application");
  option.apply(view as unknown as EditorView, option, from, to);
}

beforeEach(() => native.invoke.mockReset());
describe("owned path completion", () => {
  it("uses the captured environment and inserts a filename as a literal argument", async () => {
    const t = setup("cat ");
    native.invoke.mockResolvedValue([{ name: "$(printf injected)", kind: "file" }]);
    const result = await ownedPathCompletion(t.ctx, t.owner);
    expect(native.invoke).toHaveBeenCalledWith("fs_read_dir", { path: "/repo", showHidden: false, workspace: t.owner.workspace });
    if (!result || result.to === undefined) throw Error("Missing completion");
    apply(result.options[0], t.view, result.from, result.to);
    await flush();
    const inserted = t.view.dispatch.mock.calls[0][0].changes.insert;
    const shell = spawnSync("/bin/sh", ["-c", `printf '%s' ${inserted}`], { encoding: "utf8" });
    expect(shell.stdout).toBe("$(printf injected)");
    expect(t.owner.verify).toHaveBeenCalledTimes(2);
  });
  it.each(["leaf switch", "session restart", "close", "cwd change", "workspace navigation"])("discards a delayed listing after %s", async () => {
    const t = setup();
    const pending = deferred<Array<{ name: string; kind: string }>>();
    native.invoke.mockReturnValue(pending.promise);
    const result = ownedPathCompletion(t.ctx, t.owner);
    await flush();
    t.invalidate();
    pending.resolve([{ name: "file", kind: "file" }]);
    expect(await result).toBeNull();
  });
  it.each(["document edit", "selection change"])("rejects a delayed listing after %s", async (change) => {
    const t = setup();
    const pending = deferred<Array<{ name: string; kind: string }>>();
    native.invoke.mockReturnValue(pending.promise);
    const result = ownedPathCompletion(t.ctx, t.owner);
    await flush();
    t.view.state = change === "document edit" ? t.state.update({ changes: { from: 0, insert: "x" } }).state : t.state.update({ selection: { anchor: 1 } }).state;
    pending.resolve([{ name: "file", kind: "file" }]);
    expect(await result).toBeNull();
  });
  it.each(["owner changed", "document edited", "selection changed", "shell changed"])("does not insert after %s during acceptance", async (change) => {
    const t = setup();
    native.invoke.mockResolvedValue([{ name: "file", kind: "file" }]);
    const result = await ownedPathCompletion(t.ctx, t.owner);
    if (!result || result.to === undefined) throw Error("Missing completion");
    const verify = deferred<"posix" | "fish">();
    vi.mocked(t.owner.verify).mockReturnValueOnce(verify.promise);
    apply(result.options[0], t.view, result.from, result.to);
    if (change === "owner changed") t.invalidate();
    if (change === "document edited") t.view.state = t.state.update({ changes: { from: 0, insert: "x" } }).state;
    if (change === "selection changed") t.view.state = t.state.update({ selection: { anchor: 1 } }).state;
    verify.resolve(change === "shell changed" ? "fish" : "posix");
    await flush();
    expect(t.view.dispatch).not.toHaveBeenCalled();
  });
  it("restores document-word suggestions when no file matches", async () => {
    const t = setup("echo filename\ncat fi");
    // Compound input is intentionally refused; a plain command permits the fallback.
    native.invoke.mockResolvedValue([]);
    expect(await ownedPathCompletion(t.ctx, t.owner)).toBeNull();
    const plain = setup("echo filename fi");
    const result = await ownedPathCompletion(plain.ctx, plain.owner);
    expect(result?.options.map((o) => o.label)).toContain("filename");
    const option = result?.options.find((o) => o.label === "filename");
    if (!result || result.to === undefined || !option) throw Error("Missing word completion");
    apply(option, plain.view, result.from, result.to);
    await flush();
    expect(plain.view.dispatch).toHaveBeenCalled();
  });
  it("rejects an unavailable shell or unsafe context without listing files", async () => {
    const t = setup('cat "unsafe');
    expect(await ownedPathCompletion(t.ctx, t.owner)).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
    vi.mocked(t.owner.verify).mockRejectedValueOnce(Error("unknown shell"));
    expect(await ownedPathCompletion(setup().ctx, t.owner)).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
