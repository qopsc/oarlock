import { expect, it, vi } from "vitest";
import { DocumentSession } from "./documentSession";
import { applyReconciledBinding } from "./documentReconcile";

async function openSession() {
  const session = new DocumentSession(
    {
      read: async () => ({ kind: "text", content: "original", size: 8, mtime: 1, version: "v2:1:2:birth:hash" }),
      write: async () => ({ kind: "saved", version: "new" }),
    },
    { state: vi.fn(), dirty: vi.fn(), saved: vi.fn(), saveFailed: vi.fn(), conflict: vi.fn(), released: vi.fn(), autoSave: () => ({ enabled: false, delay: 10 }) },
  );
  session.open("/repo/old");
  await vi.waitFor(() => expect(session.bindingSnapshot()).not.toBeNull());
  session.change("unsaved draft");
  return session;
}

function bindingSnapshot(session: DocumentSession) {
  const snapshot = session.bindingSnapshot();
  if (!snapshot) throw new Error("Expected an open document binding");
  return snapshot;
}

it("recovers a missed rename without losing the draft and is idempotent", async () => {
  const session = await openSession();
  const snapshot = bindingSnapshot(session);
  const update = vi.fn();
  applyReconciledBinding(snapshot, "/repo/new", session, update);
  applyReconciledBinding(snapshot, "/repo/new", session, update);
  expect(update).toHaveBeenCalledOnce();
  expect(session.bindingSnapshot()?.path).toBe("/repo/new");
  expect(session.text()).toBe("unsaved draft");
  expect(session.hasUnsavedChanges()).toBe(true);
  session.close();
});

it("marks a renamed-away draft detached and preserves its contents", async () => {
  const session = await openSession();
  const snapshot = bindingSnapshot(session);
  const update = vi.fn();
  applyReconciledBinding(snapshot, null, session, update);
  applyReconciledBinding(snapshot, null, session, update);
  expect(session.isDetached()).toBe(true);
  expect(session.text()).toBe("unsaved draft");
  expect(session.hasUnsavedChanges()).toBe(true);
  expect(update).not.toHaveBeenCalled();
  session.close();
});

it("refuses a result captured for a different editor session", async () => {
  const first = await openSession();
  const snapshot = bindingSnapshot(first);
  const replacement = await openSession();
  const update = vi.fn();
  expect(() => applyReconciledBinding(snapshot, "/repo/new", replacement, update))
    .toThrow("changed while its binding was being checked");
  expect(replacement.text()).toBe("unsaved draft");
  expect(replacement.bindingSnapshot()?.path).toBe("/repo/old");
  expect(update).not.toHaveBeenCalled();
  first.close();
  replacement.close();
});
