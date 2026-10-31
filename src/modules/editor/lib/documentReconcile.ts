/** A document snapshot must still name the same session when a scan returns. */
export type BindingSnapshot = { path: string; version?: string; epoch: number; session: number };
export type BindingEditor = {
  bindingSnapshot: () => BindingSnapshot | null;
  isDetached: () => boolean;
  detach: () => void;
  retarget: (from: string, to: string) => boolean;
};

export function applyReconciledBinding(
  snapshot: BindingSnapshot,
  path: string | null,
  editor: BindingEditor,
  update: (path: string) => void,
): void {
  if (editor.isDetached()) return;
  const current = editor.bindingSnapshot();
  if (path !== null && current?.session === snapshot.session && current.path === path && path !== snapshot.path) return;
  if (
    !current || current.path !== snapshot.path || current.epoch !== snapshot.epoch ||
    current.version !== snapshot.version || current.session !== snapshot.session
  ) throw new Error("A document changed while its binding was being checked. Retry synchronization.");
  if (path === snapshot.path) return;
  if (path === null) {
    editor.detach();
    return;
  }
  if (!editor.retarget(snapshot.path, path))
    throw new Error("A document could not be safely moved to its reconciled path.");
  update(path);
}
