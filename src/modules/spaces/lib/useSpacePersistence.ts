import { useCallback, useEffect, useRef } from "react";
import type { Tab } from "@/modules/tabs";
import {
  scrollbackKeyForLeaf,
  terminalScrollback,
} from "@/modules/terminal/lib/terminalScrollbackRestore";
import {
  isSerializableTab,
  persistedTerminalLeafIds,
  serializeTabs,
} from "./serialize";
import { saveSpacesStore, saveState } from "./store";
import { useSpaces } from "./useSpaces";

const DEBOUNCE_MS = 3000;

type Snapshot = { tabs: Tab[]; activeId: number; activeSpaceId: string };

type Params = Snapshot & {
  /** Gate writes until boot hydration finished, so restore never round-trips. */
  enabled: boolean;
};

type LastWrite = { json: string; activeTabIndex: number };

/** The mounted persistence's flush, for quitting (`flushSpaces`). */
let flushLatest: (() => Promise<void>) | null = null;

/** Writes the window's spaces now instead of after the debounce. */
export function flushSpaces(): Promise<void> {
  return flushLatest?.() ?? Promise.resolve();
}

export function useSpacePersistence({
  tabs,
  activeId,
  activeSpaceId,
  enabled,
}: Params) {
  const last = useRef<Map<string, LastWrite>>(new Map());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Snapshot>({ tabs, activeId, activeSpaceId });
  latest.current = { tabs, activeId, activeSpaceId };

  // Seed each space's last-known active index from disk so the first flush
  // preserves it for spaces the user never opens (empty json forces one write
  // with the correct index rather than clobbering it to 0).
  if (enabled && !seeded.current) {
    seeded.current = true;
    for (const [id, idx] of Object.entries(
      useSpaces.getState().initialActiveIndex,
    )) {
      last.current.set(id, { json: "", activeTabIndex: idx });
    }
  }

  const flush = useCallback((snap: Snapshot): Promise<void> => {
    // Assigns new panes their scrollback keys before the tabs are serialized.
    const scrollback = terminalScrollback
      .persist(persistedTerminalLeafIds(snap.tabs))
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const groups = new Map<string, Tab[]>();
    for (const t of snap.tabs) {
      const arr = groups.get(t.spaceId);
      if (arr) arr.push(t);
      else groups.set(t.spaceId, [t]);
    }
    const captured = [...groups].map(([spaceId, group]) => ({
      spaceId,
      group,
      serialized: serializeTabs(group, scrollbackKeyForLeaf),
    }));
    const run = queue.current.then(async () => {
      const writes: Promise<unknown>[] = [];
      const pending = new Map<string, LastWrite>();
      for (const { spaceId, group, serialized } of captured) {
        const prev = last.current.get(spaceId);
        let activeTabIndex = prev?.activeTabIndex ?? 0;
        if (spaceId === snap.activeSpaceId) {
          const idx = group
            .filter(isSerializableTab)
            .findIndex((t) => t.id === snap.activeId);
          if (idx >= 0) activeTabIndex = idx;
        }
        const json = JSON.stringify(serialized);
        if (
          prev &&
          prev.json === json &&
          prev.activeTabIndex === activeTabIndex
        ) {
          continue;
        }
        pending.set(spaceId, { json, activeTabIndex });
        writes.push(saveState(spaceId, { tabs: serialized, activeTabIndex }));
      }
      const results = await Promise.allSettled(writes);
      const failed = results.find((result) => result.status === "rejected");
      const history = await scrollback;
      if (failed?.status === "rejected") throw failed.reason;
      if (!history.ok) throw history.error;
      await saveSpacesStore();
      for (const [id, value] of pending) last.current.set(id, value);
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const snap: Snapshot = { tabs, activeId, activeSpaceId };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush(snap).catch((error) =>
        console.warn("Could not save spaces", error),
      );
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tabs, activeId, activeSpaceId, enabled, flush]);

  useEffect(() => {
    if (!enabled) return;
    return terminalScrollback.attachLeafSource(() =>
      persistedTerminalLeafIds(latest.current.tabs),
    );
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const flushNow = () => flush(latest.current);
    flushLatest = flushNow;
    const onHidden = () => {
      if (document.visibilityState === "hidden")
        void flushNow().catch((error) =>
          console.warn("Could not save spaces", error),
        );
    };
    const onLeave = () => {
      void flushNow().catch((error) =>
        console.warn("Could not save spaces", error),
      );
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      if (flushLatest === flushNow) flushLatest = null;
      void flushNow().catch((error) =>
        console.warn("Could not save spaces", error),
      );
    };
  }, [enabled, flush]);
}
