import { createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { syntaxTree } from "@codemirror/language";
import { useDocumentLanguage } from "../../src/modules/editor/lib/useDocumentLanguage";
import { Compartment, EditorState, Prec, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, defaultKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { vimHandlersExtension } from "../../src/modules/editor/lib/vim";
import { documentLanguage, parseFiletype, vimFiletype } from "../../src/modules/editor/lib/documentLanguage";
import { resolveLanguage } from "../../src/modules/editor/lib/languageResolver";
import { indentUnit, ensureSyntaxTree } from "@codemirror/language";
const basicSetup = [
  history(),
  keymap.of(defaultKeymap),
  EditorState.allowMultipleSelections.of(true),
];
import { awaitVimIdle } from "./settle.js";
import { Vim, vim, getCM } from "@replit/codemirror-vim";
const consoleErrors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(" "));
  originalError(...args);
};
const results: { name: string; passed: boolean; error?: string }[] = [];
function assert(value: unknown, message: string) {
  if (!value) throw Error(message);
}
async function test(
  name: string,
  doc: string,
  fn: (cm: any, view: EditorView) => unknown,
) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [basicSetup, Prec.highest(vim())],
    }),
  });
  const cm = getCM(view)!;
  Vim.resetVimGlobalState_();
  Vim.mapclear();
  try {
    await fn(cm, view);
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  } finally {
    view.destroy();
    await new Promise((r) => setTimeout(r, 0));
  }
}
const text = (cm: any) => cm.getValue();
async function keys(cm: any, ...keys: string[]) {
  for (const key of keys) await Vim.handleKey(cm, key, "user");
}
function event(target: HTMLElement, key: string, type = "keydown") {
  const code =
    key === "Enter"
      ? 13
      : key === "Escape"
        ? 27
        : key.length === 1
          ? key.toUpperCase().charCodeAt(0)
          : 0;
  target.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      keyCode: code,
      bubbles: true,
      cancelable: true,
    }),
  );
}
function prompt(cm: any) {
  return cm.state.dialog.querySelector("input") as HTMLInputElement;
}
async function run() {
  await test("normal edits remain synchronous", "one two", (cm) => {
    const result = Vim.handleKey(cm, "x", "user");
    assert(!(result instanceof Promise), "normal edit became async");
    assert(text(cm) === "ne two", text(cm));
  });
  await test("substitute captures", "one 12\ntwo 34", async (cm) => {
    await Vim.handleEx(cm, "%s/(\\d+)/[$1]/g");
    assert(text(cm) === "one [12]\ntwo [34]", text(cm));
  });
  await test(
    "global and nested substitute",
    "one x\ntwo y\nthree x",
    async (cm) => {
      await Vim.handleEx(cm, "g/x/s/x/Z/");
      assert(text(cm) === "one Z\ntwo y\nthree Z", text(cm));
    },
  );
  await test("global deletion", "one x\ntwo y\nthree x", async (cm) => {
    await Vim.handleEx(cm, "g/x/d");
    assert(text(cm) === "two y", text(cm));
  });
  await test("sort pattern", "x 3\nx 1\nx 2", async (cm) => {
    await Vim.handleEx(cm, "%sort n /x /");
    assert(text(cm) === "x 1\nx 2\nx 3", text(cm));
  });
  await test("search addressed range", "first\nfoo\nlast", async (cm) => {
    await Vim.handleEx(cm, "/foo/d");
    assert(text(cm) === "first\nlast", text(cm));
  });
  await test(
    "search operator and repeat",
    "one foo two foo end",
    async (cm) => {
      Vim.map("Q", "d/foo<CR>", "normal");
      await keys(cm, "Q");
      assert(text(cm) === "foo two foo end", text(cm));
      await keys(cm, ".");
      assert(text(cm) === "foo end", text(cm));
    },
  );
  await test(
    "counted forward/backward search",
    "a foo b foo c foo",
    async (cm) => {
      Vim.map("Q", "/foo<CR>", "normal");
      await keys(cm, "Q", "2", "n");
      assert(cm.getCursor().ch === 14, JSON.stringify(cm.getCursor()));
      await keys(cm, "N");
      assert(cm.getCursor().ch === 8, JSON.stringify(cm.getCursor()));
    },
  );
  await test("macro with search and edit", "a foo b foo c foo", async (cm) => {
    Vim.map("Q", "/foo<CR>", "normal");
    await keys(cm, "q", "a", "Q", "x", "q", "@", "a");
    assert(text(cm) === "a oo b oo c foo", text(cm));
  });
  await test("stale document blocks substitution", "foo", async (cm, view) => {
    const pending = Vim.handleEx(cm, "%s/foo/bar/");
    view.dispatch({ changes: { from: 0, to: 3, insert: "new draft" } });
    try {
      await pending;
    } catch {}
    assert(text(cm) === "new draft", text(cm));
  });
  await test("queued keys run after search", "a foo", async (cm) => {
    Vim.map("Q", "/foo<CR>", "normal");
    const p = Vim.handleKey(cm, "Q", "user");
    const q = Vim.handleKey(cm, "x", "user");
    await Promise.all([p, q]);
    assert(text(cm) === "a oo", text(cm));
  });
  await test(
    "public findKey callbacks retain search ownership",
    "a foo",
    async (cm) => {
      Vim.map("Q", "/foo<CR>", "normal");
      const command = await Vim.findKey(cm, "Q", "user");
      await command?.();
      assert(cm.getCursor().ch === 2, JSON.stringify(cm.getCursor()));
    },
  );
  await test(
    "prompt submission supersedes incremental search without losing its operator",
    "a foo b",
    async (cm) => {
      await keys(cm, "d", "/");
      const field = prompt(cm);
      field.value = "foo";
      event(field, "o", "keyup");
      event(field, "Enter");
      await awaitVimIdle(cm);
      assert(text(cm) === "foo b", text(cm));
    },
  );
  await test(
    "confirmed substitutions preserve y/n/a commands",
    "foo foo foo",
    async (cm) => {
      await Vim.handleEx(cm, "%s/foo/bar/gc");
      let field = prompt(cm);
      event(field, "y");
      await awaitVimIdle(cm);
      field = prompt(cm);
      event(field, "n");
      await awaitVimIdle(cm);
      field = prompt(cm);
      event(field, "a");
      await awaitVimIdle(cm);
      assert(text(cm) === "bar foo bar", text(cm));
      assert(
        !cm.state.dialog?.querySelector("input"),
        "confirmation stayed open",
      );
    },
  );
  await test(
    "queued native typing preserves insert and Escape order",
    "a foo",
    async (cm, view) => {
      Vim.map("Q", "/foo<CR>", "normal");
      const p = Vim.handleKey(cm, "Q", "user");
      for (const k of ["c", "i", "w", "X", "Escape"]) event(view.contentDOM, k);
      await p;
      await awaitVimIdle(cm);
      assert(text(cm) === "a X", text(cm));
      assert(!cm.state.vim.insertMode, "Escape lost");
    },
  );
  await test(
    "asynchronous substitute is one undo step",
    "foo foo foo",
    async (cm) => {
      await Vim.handleEx(cm, "%s/foo/bar/g");
      await keys(cm, "u");
      assert(text(cm) === "foo foo foo", text(cm));
    },
  );
  await test(
    "hostile regex stays off the UI thread and recovers",
    "a".repeat(34) + "!",
    async (cm) => {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      try {
        await Vim.handleEx(cm, "%s/(a+)+$/X/");
      } catch {
      } finally {
        clearInterval(timer);
      }
      assert(ticks > 10, "UI blocked");
      assert(
        text(cm) === "a".repeat(34) + "!",
        "timed-out command changed text",
      );
      await Vim.handleEx(cm, "%s/!/ok/");
      assert(text(cm).endsWith("ok"), "worker did not recover");
    },
  );
  await test(
    "search jump list and Ctrl-O",
    "word\n(word)\n{word\nword.\n\nword search\n}word\nword\nword\n",
    async (cm) => {
      cm.setCursor(2, 3);
      await keys(cm, "#", "n", "<C-o>");
      assert(
        cm.getCursor().line === 1 && cm.getCursor().ch === 1,
        JSON.stringify(cm.getCursor()),
      );
    },
  );
  await test("visual search text object", "a foo b foo", async (cm) => {
    Vim.map("Q", "/foo<CR>", "normal");
    await keys(cm, "Q", "g", "n");
    assert(cm.getSelection() === "foo", cm.getSelection());
    await keys(cm, "d");
    assert(text(cm) === "a  b foo", text(cm));
  });
  await test("recording survives ordinary text input", "", async (cm, view) => {
    await keys(cm, "q", "a", "i");
    view.dispatch({
      ...view.state.replaceSelection("foo"),
      userEvent: "input.type",
    });
    assert(
      cm.state.dialog?.textContent.includes("recording @a"),
      "recording banner disappeared",
    );
    await keys(cm, "<Esc>", "q", "0", "@", "a");
    assert(text(cm) === "foofoo", text(cm));
    assert(!cm.state.dialog, "recording banner stayed open");
  });
  await test(
    "external edits cancel confirmation without disabling Vim",
    "foo foo",
    async (cm, view) => {
      await Vim.handleEx(cm, "%s/foo/bar/gc");
      view.dispatch({ changes: { from: 0, to: 3, insert: "new" } });
      await Promise.resolve();
      assert(
        !cm.state.dialog?.querySelector("input"),
        "stale confirmation remains",
      );
      await keys(cm, "<Esc>", "0", "x");
      assert(text(cm) === "ew foo", text(cm));
    },
  );
  await test(
    "block indent follows indent width rather than tab display width",
    "  word1\n  word2\n  word3",
    async (cm, view) => {
      view.dispatch({
        effects: StateEffect.appendConfig.of([
          indentUnit.of("  "),
          EditorState.tabSize.of(4),
        ]),
      });
      cm.setCursor(0, 6);
      await keys(cm, "<C-v>", "j", "j", "4", ">");
      assert(
        text(cm) === "  word        1\n  word        2\n  word        3",
        text(cm),
      );
      await keys(cm, "g", "v", "1", "4", "<");
      assert(text(cm) === "  word1\n  word2\n  word3", text(cm));
    },
  );
  await test(
    "explicit top and bottom scroll positions survive cursor motion",
    Array(500).fill("  text").join("\n"),
    async (cm, view) => {
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          EditorView.theme({
            ".cm-content": { lineHeight: "20px", padding: "0" },
          }),
        ),
      });
      cm.setSize(600, 400);
      cm.setCursor(250, 0);
      cm.refresh();
      await keys(cm, "z", "t");
      cm.refresh();
      const top = cm.getScrollInfo().top;
      await keys(cm, "z", "<CR>");
      cm.refresh();
      assert(
        Math.abs(cm.getScrollInfo().top - top) < 1,
        "z<CR> shifted explicit top alignment",
      );
      await keys(cm, "z", "b");
      cm.refresh();
      const bottom = cm.getScrollInfo().top;
      cm.setCursor(250, 0);
      cm.refresh();
      await keys(cm, "z", "-");
      cm.refresh();
      assert(
        Math.abs(cm.getScrollInfo().top - bottom) < 1,
        "z- shifted explicit bottom alignment",
      );
    },
  );
  await test(
    "visual block S keeps language indentation in valid JavaScript",
    "if (ok) {\n  alpha\n  beta\n}\n",
    async (cm, view) => {
      view.dispatch({
        effects: StateEffect.appendConfig.of([
          javascript(),
          indentUnit.of("  "),
        ]),
      });
      cm.setCursor(1, 2);
      await keys(cm, "<C-v>", "j", "S");
      view.dispatch({
        ...view.state.replaceSelection("done"),
        userEvent: "input.type",
      });
      await keys(cm, "<Esc>");
      assert(text(cm) === "if (ok) {\n  done\n}\n", text(cm));
    },
  );
  await test("filetype commands share the document override and preserve it through rename", "hello", async (cm,view) => {
    let path="/repo/sample.ts", override:string|null=null;
    const get=()=>vimFiletype(documentLanguage(path,override).id);
    view.dispatch({effects:StateEffect.appendConfig.of(vimHandlersExtension(()=>({save:async()=>true,identity:()=>path,canClose:()=>true,close:()=>{},filetype:{get,set:value=>{override=parseFiletype(value)}}})))});
    await Vim.handleEx(cm,"set filetype=python");
    assert(override==="py" && get()==="python","filetype did not reach document state");
    path="/repo/renamed.rs";view.dispatch({});
    assert(get()==="python","rename lost override");
    await Vim.handleEx(cm,"set ft&");
    assert(override===null && get()==="rust","reset did not detect new path");
    await Vim.handleEx(cm,"set ft=");
    assert(override==="txt" && get()==="","empty filetype did not select plain text");
  });
  await test("structural XML tag objects preserve attributes and nested tags", '<Root attr="a > b"><Child>hello</Child><Child /></Root>', async (cm,view) => {
    const language=await resolveLanguage("/repo/sample.xml");
    view.dispatch({effects:StateEffect.appendConfig.of(language!.ext)});
    ensureSyntaxTree(view.state,view.state.doc.length,1000);
    cm.setCursor(0,text(cm).indexOf("hello"));
    await keys(cm,"d","a","t");
    assert(text(cm)==='<Root attr="a > b"><Child /></Root>',text(cm));
  });
  await test("created React editor attaches its selected parser and clears it on disable", "", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const compartment = new Compartment();
    const extensions = [compartment.of([])];
    let actual: EditorView | null = null;
    const changed = () => {};
    const failed = (error: unknown) => { throw error; };
    function Mounted({ source, ready }: { source: string; ready: boolean }) {
      const ref = useRef<ReactCodeMirrorRef>(null);
      const [created, setCreated] = useState<EditorView | null>(null);
      const view = created;
      useDocumentLanguage(view, source, ready, compartment, changed, failed);
      return createElement(CodeMirror, { ref, value: "<Root>hello</Root>", extensions,
        onCreateEditor: (view: EditorView) => { actual = view; setCreated(view); } });
    }
    const settle = async () => { for(let i=0;i<15;i++) await new Promise(r=>setTimeout(r,20)); };
    try {
      root.render(createElement(Mounted, { source: "file.xml", ready: true })); await settle();
      const current = actual as EditorView | null;
      assert(current && syntaxTree(current.state).topNode.name === "Document", `initial XML parser missing: ${current ? syntaxTree(current.state).toString() : "no editor"}`);
      root.render(createElement(Mounted, { source: "file.py", ready: true })); await settle();
      assert(current && syntaxTree(current.state).topNode.name === "Script", "replacement Python parser missing");
      root.render(createElement(Mounted, { source: "file.py", ready: false })); await settle();
      assert(current && syntaxTree(current.state).length === 0, "disabled parser retained");
    } finally { root.unmount(); host.remove(); }
  });
  return {
    passed: results.every((r) => r.passed) && consoleErrors.length === 0,
    results,
    consoleErrors,
  };
}
run().then(report, (error) =>
  report({ passed: false, error: String(error), results }),
);
function report(value: object) {
  (window as any).webkit?.messageHandlers.out.postMessage(
    JSON.stringify(value),
  );
  document.body.textContent = JSON.stringify(value);
}
