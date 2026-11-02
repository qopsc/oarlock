/** Detection can be cancelled; once a preference save begins it may finish. */
export async function recheckLspInstall(
  current: () => boolean,
  detect: () => Promise<string | null>,
  beginSave: () => void,
  save: () => Promise<void>,
): Promise<"cancelled" | "missing" | "saved"> {
  const path = await detect();
  if (!current()) return "cancelled";
  if (!path) return "missing";
  beginSave();
  await save();
  return current() ? "saved" : "cancelled";
}
