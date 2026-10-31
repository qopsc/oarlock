import { toast } from "sonner";
import { syncAllFolders } from "@/modules/workspace/allFolders";
import { create } from "zustand";
import {
  DEFAULT_PREFERENCES,
  observePreferences,
  type Preferences,
} from "./store";

type State = Preferences & {
  /** A valid snapshot has loaded; a later synchronization error does not erase it. */
  hydrated: boolean;
  error: string | null;
  syncing: boolean;
  /** Subscribe & hydrate. Idempotent — safe to call from multiple windows. */
  init: () => Promise<void>;
};

let initPromise: Promise<void> | null = null;

const FAST_BG_KIND_KEY = "oarlock-ui-bg-kind-shadow";
const FAST_BG_IMAGE_ID_KEY = "oarlock-ui-bg-image-shadow";

function mirrorBgFastPath(
  kind: Preferences["backgroundKind"],
  imageId: Preferences["backgroundImageId"],
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAST_BG_KIND_KEY, kind);
    if (imageId) window.localStorage.setItem(FAST_BG_IMAGE_ID_KEY, imageId);
    else window.localStorage.removeItem(FAST_BG_IMAGE_ID_KEY);
  } catch {
    /* ignore */
  }
}

export function readBgFastPath(): {
  active: boolean;
  imageId: string | null;
} {
  if (typeof window === "undefined") return { active: false, imageId: null };
  try {
    const kind = window.localStorage.getItem(FAST_BG_KIND_KEY);
    const imageId = window.localStorage.getItem(FAST_BG_IMAGE_ID_KEY);
    return { active: kind === "image" && !!imageId, imageId };
  } catch {
    return { active: false, imageId: null };
  }
}

export const usePreferencesStore = create<State>((set) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  error: null,
  syncing: true,
  init: () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        await observePreferences(
          (prefs) => {
            const before = usePreferencesStore.getState();
            set({ ...prefs, hydrated: true, error: null, syncing: false });
            if (before.error) toast.dismiss("preferences-recovery");
            if (
              !before.hydrated ||
              before.backgroundKind !== prefs.backgroundKind ||
              before.backgroundImageId !== prefs.backgroundImageId
            )
              mirrorBgFastPath(prefs.backgroundKind, prefs.backgroundImageId);
          },
          (error) => {
            set({ error: String(error), syncing: false });
            toast.error("Preferences could not be synchronized", {
              id: "preferences-recovery",
              duration: Infinity,
              description: String(error),
              action: {
                label: "Retry",
                onClick: (event) => {
                  event.preventDefault();
                  void import("./nativePreferences")
                    .then((m) => m.readNativePreferences())
                    .catch(() => {});
                },
              },
            });
          },
          () => set({ syncing: true }),
        );
        syncAllFolders(usePreferencesStore);
      } catch (e) {
        initPromise = null;
        set({ error: String(e), hydrated: false, syncing: false });
        toast.error("Preferences could not be loaded", {
          id: "preferences-recovery",
          duration: Infinity,
          description: String(e),
          action: {
            label: "Retry",
            onClick: (event) => {
              event.preventDefault();
              void usePreferencesStore
                .getState()
                .init()
                .catch(() => {});
            },
          },
        });
        throw e;
      }
    })();
    void initPromise.catch(() => {});
    return initPromise;
  },
}));
