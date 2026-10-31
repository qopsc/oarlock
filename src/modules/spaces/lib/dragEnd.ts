/** Only the captured pointer can finish a drag; cancellation never commits it. */
export function spaceDragEndAction(
  drag: { pointerId: number; active: boolean } | null,
  pointerId: number,
  type: string,
): "ignore" | "cancel" | "commit" | "activate" {
  if (!drag || drag.pointerId !== pointerId) return "ignore";
  if (type !== "pointerup") return "cancel";
  return drag.active ? "commit" : "activate";
}

/** Release only our pointer and restore the selection style we replaced. */
export function releaseSpaceDrag(
  drag: { pointerId: number; capture: Element; previousSelection: string | null } | null,
  style: { userSelect: string },
): void {
  if (!drag) return;
  try {
    if (drag.capture.hasPointerCapture?.(drag.pointerId))
      drag.capture.releasePointerCapture(drag.pointerId);
  } catch {
    // The browser may already have revoked pointer capture.
  }
  if (drag.previousSelection !== null && style.userSelect === "none")
    style.userSelect = drag.previousSelection;
}
