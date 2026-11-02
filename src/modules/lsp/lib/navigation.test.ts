import { EditorState } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { lspInteractions, type OarlockLspClient } from "./client";

it("does not navigate when a definition arrives after its editor was destroyed", async () => {
  let finish!: (result: unknown) => void;
  const client = {
    textDocumentDefinition: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as OarlockLspClient;
  const open = vi.fn();
  const state = EditorState.create({
    doc: "symbol",
    extensions: lspInteractions({
      client,
      documentUri: "file:///repo/a.ts",
      rootPath: "/repo",
      onExternal: open,
    }),
  });
  const lifetime = { active: true };
  const view = {
    state,
    plugin: () => lifetime,
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorView;
  state
    .facet(keymap)
    .flat()
    .find((binding) => binding.key === "F12")
    ?.run?.(view);
  lifetime.active = false;
  finish({
    uri: "file:///repo/b.ts",
    range: { start: { line: 0, character: 0 } },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(open).not.toHaveBeenCalled();
});

it("keeps references at different columns on the same line", async () => {
  const client = {
    textDocumentReferences: async () => [
      { uri: "file:///repo/b.ts", range: { start: { line: 1, character: 0 } } },
      { uri: "file:///repo/b.ts", range: { start: { line: 1, character: 8 } } },
    ],
  } as unknown as OarlockLspClient;
  const state = EditorState.create({
    doc: "symbol",
    extensions: lspInteractions({
      client,
      documentUri: "file:///repo/a.ts",
      rootPath: "/repo",
      onExternal: vi.fn(),
    }),
  });
  const dispatch = vi.fn();
  const lifetime = { active: true };
  const view = {
    state,
    plugin: () => lifetime,
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorView;
  state
    .facet(keymap)
    .flat()
    .find((binding) => binding.key === "Shift-F12")
    ?.run?.(view);
  await Promise.resolve();
  const items = dispatch.mock.calls[0][0].effects.value.items;
  expect(items).toHaveLength(2);
  expect(items[0].label).not.toBe(items[1].label);
});

it("ignores older results and replies for changed documents, selections or hidden panes", async () => {
  const completions: ((value: unknown) => void)[] = [];
  const client = {
    textDocumentDefinition: () => new Promise((resolve) => completions.push(resolve)),
  } as unknown as OarlockLspClient;
  const open = vi.fn();
  const owner = { current: { active: true, generation: 0 } };
  const state = EditorState.create({
    doc: "symbol",
    extensions: lspInteractions({ client, documentUri: "file:///repo/a.ts", rootPath: "/repo", onExternal: open, owner }),
  });
  const fakeView = { state, plugin: () => ({ active: true }), dispatch: vi.fn(), focus: vi.fn() };
  const view = fakeView as unknown as EditorView;
  const run = () => state.facet(keymap).flat().find((binding) => binding.key === "F12")?.run?.(view);
  const result = (name: string) => ({ uri: `file:///repo/${name}.ts`, range: { start: { line: 0, character: 0 } } });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

  run(); run();
  completions[1](result("new"));
  await flush();
  completions[0](result("old"));
  await flush();
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith("file:///repo/new.ts", 1);

  run();
  fakeView.state = fakeView.state.update({ changes: { from: 0, insert: "x" } }).state;
  completions[2](result("edited"));
  await flush();
  run();
  fakeView.state = fakeView.state.update({ selection: { anchor: 1 } }).state;
  completions[3](result("moved"));
  await flush();
  run();
  owner.current = { active: false, generation: 1 };
  owner.current = { active: true, generation: 2 };
  completions[4](result("hidden"));
  await flush();
  expect(open).toHaveBeenCalledTimes(1);
});

it("a newer references request supersedes an older definition request", async () => {
  let finishDefinition!: (value: unknown) => void;
  let finishReferences!: (value: unknown) => void;
  const client = {
    textDocumentDefinition: () => new Promise((resolve) => { finishDefinition = resolve; }),
    textDocumentReferences: () => new Promise((resolve) => { finishReferences = resolve; }),
  } as unknown as OarlockLspClient;
  const open = vi.fn();
  const state = EditorState.create({ doc: "symbol", extensions: lspInteractions({
    client, documentUri: "file:///repo/a.ts", rootPath: "/repo", onExternal: open,
  }) });
  const view = { state, plugin: () => ({ active: true }), dispatch: vi.fn(), focus: vi.fn() } as unknown as EditorView;
  for (const key of ["F12", "Shift-F12"])
    state.facet(keymap).flat().find((binding) => binding.key === key)?.run?.(view);
  const location = { uri: "file:///repo/b.ts", range: { start: { line: 0, character: 0 } } };
  finishReferences([location]);
  await Promise.resolve();
  finishDefinition(location);
  await Promise.resolve();
  expect(open).toHaveBeenCalledOnce();
});
