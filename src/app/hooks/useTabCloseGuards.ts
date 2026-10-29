import {
  type CloseManyHazards,
  type CloseManyKind,
  type CloseManyPending,
  evaluateCloseHazards,
  partitionDeletedTabs,
  hasCloseManyHazards,
  hasNewCloseManyHazards,
} from "@/app/hooks/tabCloseGuards";
import { hasNewEdits } from "@/app/hooks/quitApproval";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type CloseTabsPlan,
  nextActiveInSpace,
  planCloseOtherTabs,
  planCloseTabsToRight,
  type Tab,
} from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

function confirmRunningTerminal(): boolean {
  return usePreferencesStore.getState().confirmCloseRunningTerminal;
}

type Params = {
  tabs: Tab[];
  activeId: number;
  editorIsDirty?: (id: number) => boolean | undefined;
  editorCloseRevision?: (id: number) => string | undefined;
  disposeTab: (id: number) => void;
  disposeDeletedTabs: (ids: number[]) => void;
  disposeTabs: (anchorId: number, plan: CloseTabsPlan) => void;
};

/**
 * Guards tab closing: dirty editors and terminals with a live foreground
 * process route through a confirmation dialog instead of closing immediately.
 * Owns the pending-close states the dialogs render from.
 */
export function useTabCloseGuards({
  tabs,
  activeId,
  editorIsDirty,
  editorCloseRevision,
  disposeTab,
  disposeDeletedTabs,
  disposeTabs,
}: Params) {
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  }, [tabs, activeId]);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  const [pendingCloseMany, setPendingCloseMany] =
    useState<CloseManyPending | null>(null);
  const [closeManyConfirming, setCloseManyConfirming] = useState(false);
  const closeManyRequestRef = useRef(0);
  const acknowledgedRevisionsRef = useRef(new Map<number, unknown>());

  const handleClose = useCallback(
    async (id: number) => {
      // Last tab in its space can't be closed (closeTab refuses). Skip the
      // dialog entirely so confirming it doesn't appear to silently fail.
      if (nextActiveInSpace(tabs, id) === null) return;
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && (editorIsDirty?.(id) ?? t.dirty)) {
        setPendingCloseTab(id);
        return;
      }
      if (t?.kind === "terminal" && confirmRunningTerminal()) {
        const leaves = leafIds(t.paneTree);
        const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
        if (checks.some(Boolean)) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      disposeTab(id);
    },
    [tabs, disposeTab, editorIsDirty],
  );

  const captureCloseMany = useCallback((closeIds: number[]) => {
    const close = new Set(closeIds);
    const affected = tabsRef.current.filter((tab) => close.has(tab.id));
    return {
      dirtyIds: affected
        .filter(
          (tab) => tab.kind === "editor" && (editorIsDirty?.(tab.id) ?? tab.dirty),
        )
        .map((tab) => tab.id),
      leafIds: affected
        .filter((tab) => tab.kind === "terminal")
        .flatMap((tab) => leafIds(tab.paneTree)),
    };
  }, [editorIsDirty]);

  const dirtyRevisions = useCallback((closeIds: number[]) => {
    const close = new Set(closeIds);
    const revisions = new Map<number, unknown>();
    for (const tab of tabsRef.current) {
      if (close.has(tab.id) && tab.kind === "editor" &&
          (editorIsDirty?.(tab.id) ?? tab.dirty)) {
        revisions.set(tab.id, editorCloseRevision?.(tab.id) ?? tab);
      }
    }
    return revisions;
  }, [editorIsDirty, editorCloseRevision]);

  const evaluateCloseMany = useCallback(
    (closeIds: number[]): Promise<CloseManyHazards> =>
      evaluateCloseHazards(
        () => captureCloseMany(closeIds),
        leafHasForegroundProcess,
        confirmRunningTerminal(),
      ),
    [captureCloseMany],
  );

  const planCloseMany = useCallback(
    (kind: CloseManyKind, anchorId: number) =>
      kind === "right"
        ? planCloseTabsToRight(tabsRef.current, anchorId, activeIdRef.current)
        : planCloseOtherTabs(tabsRef.current, anchorId, activeIdRef.current),
    [],
  );

  const withCurrentActive = useCallback(
    (plan: CloseTabsPlan): CloseTabsPlan => ({
      closeIds: plan.closeIds,
      nextActiveId: activeIdRef.current,
    }),
    [],
  );

  const handleCloseMany = useCallback(
    async (kind: CloseManyKind, anchorId: number) => {
      const plan = planCloseMany(kind, anchorId);
      if (plan.closeIds.length === 0) return;
      const requestId = ++closeManyRequestRef.current;
      const evaluated = await evaluateCloseMany(plan.closeIds);
      if (requestId !== closeManyRequestRef.current) return;
      const revisions = dirtyRevisions(plan.closeIds);
      const hazards = { ...evaluated, dirtyIds: [...revisions.keys()] };
      if (hasCloseManyHazards(hazards)) {
        acknowledgedRevisionsRef.current = revisions;
        setPendingCloseMany({ kind, anchorId, plan, ...hazards });
        return;
      }
      disposeTabs(anchorId, withCurrentActive(plan));
    },
    [disposeTabs, dirtyRevisions, evaluateCloseMany, planCloseMany, withCurrentActive],
  );

  const handleCloseTabsToRight = useCallback(
    (anchorId: number) => {
      void handleCloseMany("right", anchorId);
    },
    [handleCloseMany],
  );

  const handleCloseOtherTabs = useCallback(
    (anchorId: number) => {
      void handleCloseMany("other", anchorId);
    },
    [handleCloseMany],
  );

  const confirmCloseMany = useCallback(async () => {
    if (pendingCloseMany === null) return;
    const requestId = ++closeManyRequestRef.current;
    setCloseManyConfirming(true);
    const evaluated = await evaluateCloseMany(pendingCloseMany.plan.closeIds);
    if (requestId !== closeManyRequestRef.current) return;
    const revisions = dirtyRevisions(pendingCloseMany.plan.closeIds);
    const hazards = { ...evaluated, dirtyIds: [...revisions.keys()] };
    if (hasNewCloseManyHazards(pendingCloseMany, hazards) ||
        hasNewEdits(revisions, acknowledgedRevisionsRef.current)) {
      acknowledgedRevisionsRef.current = revisions;
      setPendingCloseMany({ ...pendingCloseMany, ...hazards });
      setCloseManyConfirming(false);
      return;
    }
    disposeTabs(
      pendingCloseMany.anchorId,
      withCurrentActive(pendingCloseMany.plan),
    );
    setPendingCloseMany(null);
    acknowledgedRevisionsRef.current.clear();
    setCloseManyConfirming(false);
  }, [pendingCloseMany, disposeTabs, dirtyRevisions, evaluateCloseMany, withCurrentActive]);

  const cancelCloseMany = useCallback(() => {
    closeManyRequestRef.current += 1;
    acknowledgedRevisionsRef.current.clear();
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
  }, []);

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const confirmTerminalClose = useCallback(() => {
    if (pendingTerminalCloseTab !== null) disposeTab(pendingTerminalCloseTab);
    setPendingTerminalCloseTab(null);
  }, [pendingTerminalCloseTab, disposeTab]);

  const cancelTerminalClose = useCallback(() => {
    setPendingTerminalCloseTab(null);
  }, []);

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      disposeDeletedTabs(pendingDeleteTabs);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeDeletedTabs]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathsDeleted = useCallback(
    (ids: number[], isDirty: (id: number) => boolean | undefined) => {
      const affected = partitionDeletedTabs(tabsRef.current, ids, isDirty);
      disposeDeletedTabs(affected.cleanIds);
      if (affected.dirtyIds.length > 0) {
        setPendingDeleteTabs((current) => [
          ...new Set([...(current ?? []), ...affected.dirtyIds]),
        ]);
      }
    },
    [disposeDeletedTabs],
  );

  return {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    cancelCloseMany,
    handlePathsDeleted,
  };
}
