import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { ownedPathCompletion } from "./ownedPathCompletion";

it("rejects an old lookup after the selection moves away and back", async () => {
  const state = EditorState.create({ doc: "cat fi", selection: { anchor: 6 } });
  const view = { state, dispatch: vi.fn() };
  const ctx = new CompletionContext(state, 6, true, view as unknown as EditorView);
  let finish: (entries: Array<{ name: string; kind: string }>) => void = () => {};
  native.invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const result = ownedPathCompletion(ctx, { cwd: "/repo", workspace: { kind: "local" }, active: () => true, verify: async () => "posix" });
  await Promise.resolve();
  await Promise.resolve();
  view.state = state.update({ selection: { anchor: 2 } }).state;
  view.state = view.state.update({ selection: { anchor: 6 } }).state;
  finish([{ name: "file", kind: "file" }]);
  expect(await result).toBeNull();
});
