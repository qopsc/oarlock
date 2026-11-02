import type { BoundedPtyWriter } from "./BoundedPtyWriter";

/** Prepare at the queued position, then recheck ownership before publishing. */
export function scheduleOwnedInput(
  writer: BoundedPtyWriter,
  owner: { active: () => boolean },
  prepare: () => Promise<string>,
  valid: () => boolean,
  write: (data: string, valid: () => boolean) => boolean,
  cancelled: () => void,
  failed: (error: unknown) => void,
): boolean {
  const slot = writer.reserveInput();
  if (!slot) return false;
  slot(() => {
    if (!owner.active() || !valid()) { cancelled(); return; }
    const ready = writer.reserveInput();
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Terminal input preparation timed out.")), 10_000);
    });
    void Promise.race([Promise.resolve().then(prepare), deadline]).then(
      (data) => ready(() => {
        if (!owner.active() || !valid()) { cancelled(); return; }
        write(data, valid);
      }, data.length * 2),
      (error) => ready(() => failed(error)),
    ).finally(() => clearTimeout(timer));
  });
  return true;
}
