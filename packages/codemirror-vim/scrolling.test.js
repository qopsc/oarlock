import { expect, it, vi } from "vitest";
import { CodeMirror } from "./index.js";
function editor() {
  return {
    curOp: { isVimOp: true, cursorActivity: true },
    cm6: { scrollDOM: { scrollTop: 0, scrollLeft: 0 } },
    scrollIntoView: vi.fn(),
  };
}
it("explicit Vim scrolling is not displaced by automatic cursor reveal", () => {
  const cm = editor();
  CodeMirror.prototype.scrollTo.call(cm, null, 123);
  CodeMirror.prototype.onBeforeEndOperation.call(cm);
  expect(cm.cm6.scrollDOM.scrollTop).toBe(123);
  expect(cm.scrollIntoView).not.toHaveBeenCalled();
  expect(cm.curOp).toBeNull();
});
it("ordinary Vim cursor motion still reveals the cursor", () => {
  const cm = editor();
  CodeMirror.prototype.onBeforeEndOperation.call(cm);
  expect(cm.scrollIntoView).toHaveBeenCalledOnce();
});
