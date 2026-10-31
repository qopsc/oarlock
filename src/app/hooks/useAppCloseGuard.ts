import {
  editorQuitSealed,
  sealEditors,
  releaseEditors,
} from "@/modules/editor/lib/quitBarrier";
import {
  hasNewEdits,
  QuitApproval,
  type QuitRequest,
  type QuitResume,
} from "./quitApproval";
import { toast } from "sonner";
import { flushPersist } from "@/modules/ai/store/chatStore";
import {
  type FlushResult,
  flushSessionWrites,
} from "@/modules/ai/lib/sessions";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openAppWindowCount, quitApp } from "@/lib/appWindow";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { flushSpaces } from "@/modules/spaces/lib/useSpacePersistence";

async function anyTerminalBusy(tabs: Tab[]): Promise<boolean> {
  const leaves = tabs.flatMap((t) =>
    t.kind === "terminal" ? leafIds(t.paneTree) : [],
  );
  if (leaves.length === 0) return false;
  const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
  return checks.some(Boolean);
}

/** How long closing waits for chat history to reach the disk. */
export const CLOSE_FLUSH_TIMEOUT_MS = 4_000;
/**
 * How long closing waits for terminal scrollback, saved alongside chat
 * history. Scrollback is a convenience, so it gets less time.
 */
export const CLOSE_SCROLLBACK_TIMEOUT_MS = 1_500;

/**
 * Failing to save chat history must never make the window impossible to close.
 * The first failed flush keeps the window open once, with a visible error and a
 * "Close anyway" action; any further close request closes immediately.
 */
export function closeAfterFlush(
  flush: Pick<FlushResult, "ok">,
  alreadyWarned: boolean,
): "close" | "warn" {
  return flush.ok || alreadyWarned ? "close" : "warn";
}

export async function boundedSpaceFlush(
  flush: () => Promise<void>,
  timeoutMs: number,
): Promise<Pick<FlushResult, "ok" | "timedOut">> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(flush)
        .then(() => ({ ok: true, timedOut: false })),
      new Promise<{ ok: boolean; timedOut: boolean }>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, timedOut: true }),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    console.warn("Could not save spaces before closing", error);
    return { ok: false, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

export type AppCloseBlocker = {
  dirtyEditors: number;
  busyTerminal: boolean;
};

/**
 * The opt-out only covers running processes, so it stays hidden whenever the
 * same prompt is also the last warning before discarding unsaved buffers.
 */
export function canOptOutOfAppClosePrompt(blocker: AppCloseBlocker): boolean {
  return blocker.busyTerminal && blocker.dirtyEditors === 0;
}

/** A close or quit waiting for the user to confirm. */
export type PendingAppClose = AppCloseBlocker & {
  /** Oarlock quits: a quit request, or the last window closing. */
  quits: boolean;
  /** The quit request this answers (`windows.rs`); null for a close. */
  quitRound: number | null;
  quitRequest?: QuitRequest;
};

/**
 * Guards closing this window and quitting Oarlock (asked of each window in turn
 * by `windows.rs`): running commands and unsaved files are confirmed first,
 * then chat history, scrollback and spaces are saved.
 */
export function useAppCloseGuard(
  tabsRef: RefObject<Tab[]>,
  editorIsDirty?: (id: number) => boolean | undefined,
  editorCloseRevision?: (id: number) => string | undefined,
) {
  const [pendingAppClose, setPendingAppClose] =
    useState<PendingAppClose | null>(null);
  const pending = useRef<{
    request: PendingAppClose;
    revisions: Map<number, unknown>;
  } | null>(null);
  const attempt = useRef(0);
  const dirtyRevisions = useCallback(() => {
    const revisions = new Map<number, unknown>();
    for (const tab of tabsRef.current) {
      if (tab.kind === "editor" && (editorIsDirty?.(tab.id) ?? tab.dirty)) {
        revisions.set(tab.id, editorCloseRevision?.(tab.id) ?? tab);
      }
    }
    return revisions;
  }, [tabsRef, editorIsDirty, editorCloseRevision]);
  const readRevisions = useRef(dirtyRevisions);
  readRevisions.current = dirtyRevisions;
  const approvalRef = useRef<QuitApproval | null>(null);
  if (!approvalRef.current)
    approvalRef.current = new QuitApproval({
      read: () => readRevisions.current(),
      flush: async () => {
        const flush = await saveState();
        if (closeAfterFlush(flush, warned.current) === "close") return true;
        warned.current = true;
        toast.error("Could not save application state", {
          id: "close-save-failed",
          duration: Number.POSITIVE_INFINITY,
          description: "Recent workspace or chat changes may be lost.",
          action: { label: "Quit anyway", onClick: () => void quitApp() },
        });
        return false;
      },
      answer: (request, ok) =>
        invoke("app_quit_ready", {
          round: request.round,
          ticket: request.ticket,
          ok,
        }),
      changed: (request) =>
        invoke("app_quit_changed", {
          round: request.round,
          ticket: request.ticket,
        }),
      cancel: (round) => invoke<boolean>("app_quit_cancel", { round }),
      resumed: (cancelled) => {
        if (!cancelled) return;
        attempt.current += 1;
        if (pending.current?.request.quitRound !== null) {
          pending.current = null;
          setPendingAppClose(null);
        }
      },
      interrupted: () =>
        toast.info("Quit cancelled because files changed", {
          id: "quit-files-changed",
          description:
            "Document updates are being applied. You can quit again when ready.",
        }),
      failed: () =>
        toast.error("Could not finish quitting", {
          id: "quit-check-failed",
          description:
            "Your documents are still open. Please try quitting again.",
        }),
    });
  const approval = approvalRef.current;
  const ask = useCallback(
    (request: PendingAppClose) => {
      const revisions = dirtyRevisions();
      request = { ...request, dirtyEditors: revisions.size };
      pending.current = { request, revisions };
      setPendingAppClose(request);
    },
    [dirtyRevisions],
  );
  const forceClose = useRef(false);
  const closing = useRef(false);
  const closeIdle = useRef<Promise<void>>(Promise.resolve());
  const warned = useRef(false);
  const closeWindow = useCallback(async () => {
    const seal = `window-close:${attempt.current}`;
    if (!sealEditors(seal)) return;
    forceClose.current = true;
    try {
      await getCurrentWindow().close();
    } catch (error) {
      forceClose.current = false;
      releaseEditors(seal);
      toast.error("Could not close the window", {
        description: String(error),
      });
    }
  }, []);
  const blocker = useCallback(async (): Promise<AppCloseBlocker | null> => {
    // Opting out skips the per-leaf IPC entirely; it never relaxes the
    // unsaved-changes guard below.
    const busyTerminal =
      usePreferencesStore.getState().confirmCloseRunningTerminal &&
      (await anyTerminalBusy(tabsRef.current));
    // Count after the await so edits made during the IPC check are seen.
    const dirtyEditors = tabsRef.current.filter(
      (t) => t.kind === "editor" && (editorIsDirty?.(t.id) ?? t.dirty),
    ).length;
    return dirtyEditors > 0 || busyTerminal
      ? { dirtyEditors, busyTerminal }
      : null;
  }, [tabsRef, editorIsDirty]);
  /** Saves chat history, scrollback and spaces; reports either failure. */
  const saveState = useCallback(async () => {
    flushPersist();
    const [flush, spaces] = await Promise.all([
      flushSessionWrites({ timeoutMs: CLOSE_FLUSH_TIMEOUT_MS }),
      boundedSpaceFlush(flushSpaces, CLOSE_SCROLLBACK_TIMEOUT_MS),
    ]);
    return {
      ...flush,
      ok: flush.ok && spaces.ok,
      timedOut: flush.timedOut || spaces.timedOut,
    };
  }, []);
  const finish = useCallback(
    async (
      request: QuitRequest | null,
      approved = new Map<number, unknown>(),
      quits = request !== null,
    ) => {
      if (closing.current) {
        await closeIdle.current;
        if (request && approval.isCurrent(request))
          return finish(request, approved, quits);
        return;
      }
      const round = request?.round ?? null;
      closing.current = true;
      let complete!: () => void;
      closeIdle.current = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const generation = ++attempt.current;
      try {
        const flush = await saveState();
        if (
          generation !== attempt.current ||
          (request && !approval.isCurrent(request))
        )
          return;
        const current = dirtyRevisions();
        if (hasNewEdits(current, approved)) {
          ask({
            dirtyEditors: current.size,
            busyTerminal: false,
            quits,
            quitRound: round,
            quitRequest: request ?? undefined,
          });
          return;
        }
        if (closeAfterFlush(flush, warned.current) === "warn") {
          warned.current = true;
          if (round !== null) void approval.abort(round);
          toast.error("Could not save application state", {
            id: "close-save-failed",
            duration: Number.POSITIVE_INFINITY,
            description: flush.timedOut
              ? "Saving is taking too long. Recent workspace or chat changes may be lost."
              : "Recent workspace or chat changes may be lost.",
            action: {
              label: round === null ? "Close anyway" : "Quit anyway",
              // A toast can remain visible while more edits arrive. Re-enter the
              // guard instead of bypassing the document revision check.
              onClick: () => {
                // Restart the native protocol after a failed quit flush; its
                // aborted ticket can never be reused for approval.
                if (round !== null) {
                  void quitApp();
                  return;
                }
                if (generation !== attempt.current) return;
                void finish(null, approved, quits);
              },
            },
          });
          return;
        }
        if (round === null) await closeWindow();
        else if (request) approval.approve(request, current);
      } finally {
        closing.current = false;
        complete();
      }
    },
    [closeWindow, saveState, dirtyRevisions, ask, approval],
  );

  useEffect(() => {
    approval.activate();
    return () => {
      attempt.current += 1;
      approval.dispose();
    };
  }, [approval]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (disposed || forceClose.current) return;
        event.preventDefault();
        if (editorQuitSealed() || closing.current || pending.current) return;
        const generation = ++attempt.current;
        const current = () =>
          !disposed &&
          generation === attempt.current &&
          !editorQuitSealed() &&
          !closing.current &&
          !pending.current;
        const found = await blocker();
        if (!current()) return;
        const quits = (await openAppWindowCount()) <= 1;
        if (!current()) return;
        if (found) ask({ ...found, quits, quitRound: null });
        else void finish(null, undefined, quits);
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [blocker, finish, ask]);

  useEffect(() => {
    let disposed = false;
    const window = getCurrentWindow();
    const registrations = [
      window.listen<QuitResume>("oarlock:quit-resume", ({ payload }) => {
        approval.resume(payload);
        if (payload.message)
          toast.error("Could not finish quitting", {
            id: "quit-check-failed",
            description: payload.message,
          });
      }),
      window.listen<QuitRequest>(
        "oarlock:quit-requested",
        async ({ payload: request }) => {
          if (disposed || !approval.begin(request)) return;
          // Accepted native requests supersede local preflight checks, including
          // ones still awaiting process inspection or the open-window count.
          attempt.current += 1;
          if (request.verify) {
            void approval.verify(request);
            return;
          }
          const found = await blocker();
          if (disposed || !approval.isCurrent(request)) return;
          if (!found) {
            void finish(request);
            return;
          }
          await window.unminimize().catch(() => {});
          await window.show().catch(() => {});
          await window.setFocus().catch(() => {});
          if (!disposed && approval.isCurrent(request))
            ask({
              ...found,
              quits: true,
              quitRound: request.round,
              quitRequest: request,
            });
        },
      ),
    ];
    void Promise.all(registrations)
      .then(() => {
        if (!disposed) void invoke("app_window_ready").catch(() => {});
      })
      .catch(() => toast.error("Could not install the quit guard"));
    return () => {
      disposed = true;
      for (const registration of registrations)
        void registration.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [blocker, finish, ask, approval]);

  const confirmAppClose = useCallback(
    (expected?: PendingAppClose) => {
      const accepted = pending.current;
      if (!accepted || (expected && accepted.request !== expected)) return;
      pending.current = null;
      setPendingAppClose(null);
      void finish(
        accepted.request.quitRequest ?? null,
        accepted.revisions,
        accepted.request.quits,
      );
    },
    [finish],
  );

  const cancelAppClose = useCallback(() => {
    if (!pending.current) return;
    attempt.current += 1;
    const round = pending.current?.request.quitRound ?? null;
    if (round !== null) void approval.abort(round);
    pending.current = null;
    setPendingAppClose(null);
  }, [approval]);

  return { pendingAppClose, confirmAppClose, cancelAppClose };
}
