import { expect, it } from "vitest";
import { releaseSpaceDrag, spaceDragEndAction } from "./dragEnd";

it("never commits or activates when pointer capture is cancelled", () => {
  expect(spaceDragEndAction({ pointerId: 4, active: true }, 4, "pointercancel")).toBe("cancel");
  expect(spaceDragEndAction({ pointerId: 4, active: false }, 4, "pointercancel")).toBe("cancel");
  expect(spaceDragEndAction({ pointerId: 4, active: true }, 4, "lostpointercapture")).toBe("cancel");
});

it("restores selection even when the browser already revoked capture", () => {
  const style = { userSelect: "none" };
  const capture = {
    hasPointerCapture: () => true,
    releasePointerCapture: () => { throw new Error("already released"); },
  } as unknown as Element;
  releaseSpaceDrag({ pointerId: 4, capture, previousSelection: "text" }, style);
  expect(style.userSelect).toBe("text");
});
it("only the captured pointer can complete a normal drag or click", () => {
  expect(spaceDragEndAction({ pointerId: 4, active: true }, 9, "pointerup")).toBe("ignore");
  expect(spaceDragEndAction({ pointerId: 4, active: true }, 4, "pointerup")).toBe("commit");
  expect(spaceDragEndAction({ pointerId: 4, active: false }, 4, "pointerup")).toBe("activate");
});
