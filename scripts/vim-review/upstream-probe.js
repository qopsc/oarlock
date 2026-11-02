window.addEventListener("error", (e) =>
  report({ passed: false, uncaught: e.message }),
);
window.addEventListener("unhandledrejection", (e) =>
  report({
    passed: false,
    rejection: String(e.reason),
    case: window.currentVimCase,
    stack: e.reason?.stack,
  }),
);
import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
} from "@codemirror/view";
import { history, defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  indentUnit,
  bracketMatching,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { xml } from "@codemirror/lang-xml";
import { CodeMirror as Adapter, Vim, vim, getCM } from "@replit/codemirror-vim";
import { vimTests } from "./upstream-adapted.js";
import { awaitVimIdle } from "./settle.js";
const views = [];
function CodeMirror(parent, options) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.value || "",
      extensions: [
        EditorView.theme({
          ".cm-content": { lineHeight: "20px", padding: "0" },
        }),
        history(),
        keymap.of([...defaultKeymap, indentWithTab]),
        lineNumbers(),
        drawSelection(),
        bracketMatching(),
        options.mode === "xml" ? xml() : javascript(),
        indentUnit.of(
          options.indentWithTabs ? "\t" : " ".repeat(options.indentUnit || 2),
        ),
        EditorState.tabSize.of(options.tabSize || 4),
        EditorState.allowMultipleSelections.of(true),
        Prec.highest(vim()),
        ...(options.lineWrapping ? [EditorView.lineWrapping] : []),
      ],
    }),
  });
  view.contentDOM._handleInputEventForTest = (text) => {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({
        ...view.state.replaceSelection(text),
        userEvent: "input.type",
      });
    if (
      !view.state
        .facet(EditorView.inputHandler)
        .some((handler) => handler(view, from, to, text, insert))
    )
      view.dispatch(insert());
  };
  views.push(view);
  return getCM(view);
}
for (const key of Object.keys(Adapter))
  Object.defineProperty(CodeMirror, key, {
    get: () => Adapter[key],
    set: (value) => {
      Adapter[key] = value;
    },
    configurable: true,
  });
Object.assign(CodeMirror, {
  Vim,
  version: "6",
  platformMac: /Mac/.test(navigator.platform),
});
const cases = [];
await vimTests(CodeMirror, (name, fn, expectedFail) =>
  cases.push({ name, fn, expectedFail }),
);
const ground = document.createElement("div");
ground.id = "testground";
document.body.appendChild(ground);
let passed = 0;
const failures = [];
const deadline = setTimeout(
  () =>
    report({
      passed: false,
      timeout: true,
      total: cases.length,
      completed: passed + failures.length,
      failures,
    }),
  120000,
);
for (const { name, fn, expectedFail } of cases) {
  window.currentVimCase = name;
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push({ name, error: String(error), expectedFail });
  } finally {
    for (const view of views.splice(0)) {
      try {
        await awaitVimIdle(getCM(view));
      } catch {}
      view.destroy();
    }
    ground.replaceChildren();
  }
}
clearTimeout(deadline);
report({ passed: true, total: cases.length, success: passed, failures });
function report(value) {
  window.webkit?.messageHandlers.out.postMessage(JSON.stringify(value));
  document.body.textContent = JSON.stringify(value);
}
