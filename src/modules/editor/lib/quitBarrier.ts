/** Window-local, operation-scoped final quit barrier. No timers or subscriptions
 * exist here unless a quit round is in progress. */
let seal: string | null = null;
let cancelSeal: (() => void) | undefined;
let cancellationRequested = false;
let pendingMutations = 0;
const waitingMutations = new Set<() => void>();
let restoreInput: (() => void) | null = null;
const deferred = new Map<object, Map<string, () => void>>();
const listeners = new Set<() => void>();
export const editorQuitSealed = () => seal !== null;
export const editorMutationsPending = () => pendingMutations > 0;
export function sealEditors(key: string, cancel?: () => void): boolean {
  if (seal !== null) return seal === key;
  if (editorMutationsPending()) return false;
  seal = key;
  cancelSeal = cancel;
  cancellationRequested = false;
  if (typeof document === "undefined") return true;
  const root = document.getElementById("root");
  if (!root) return true;
  const inert = root.inert;
  root.inert = true;
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  status.textContent = "Finishing quit…";
  status.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:var(--background);color:var(--foreground);font:14px system-ui";
  document.body.append(status);
  restoreInput = () => {
    root.inert = inert;
    status.remove();
  };
  return true;
}
export function releaseEditors(key: string): void {
  if (seal !== key) return;
  seal = null;
  cancelSeal = undefined;
  cancellationRequested = false;
  restoreInput?.();
  restoreInput = null;
  const waiting = [...waitingMutations];
  waitingMutations.clear();
  for (const ready of waiting) ready();
  const work = [...deferred.values()].flatMap((items) => [...items.values()]);
  deferred.clear();
  for (const apply of work) apply();
}
/** Reserve a mutation batch before requesting native cancellation. A new final
 * check cannot seal between cancellation and application of those identities.
 * A local close already dispatched cannot be cancelled; its failure releases
 * the waiter, and successful closure destroys the page instead. */
export function beginDocumentMutation(): {
  ready: Promise<void> | null;
  release: () => void;
} {
  pendingMutations += 1;
  let resolve: (() => void) | undefined;
  const ready =
    seal === null
      ? null
      : new Promise<void>((done) => {
          resolve = done;
          waitingMutations.add(done);
        });
  let live = true;
  const release = () => {
    if (!live) return;
    live = false;
    pendingMutations -= 1;
    if (resolve) {
      waitingMutations.delete(resolve);
      resolve();
    }
  };
  if (seal !== null && cancelSeal && !cancellationRequested) {
    cancellationRequested = true;
    cancelSeal();
  }
  return { ready, release };
}

export function deferEditorLifecycle(
  owner: object,
  kind: string,
  apply: () => void,
): boolean {
  if (!editorQuitSealed()) return false;
  const work = deferred.get(owner) ?? new Map<string, () => void>();
  work.set(kind, apply);
  deferred.set(owner, work);
  return true;
}
export function subscribeDocumentRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function documentRevisionChanged(): void {
  for (const listener of listeners) listener();
}
