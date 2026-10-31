import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toast } from "sonner";
import { createWatchHealthMonitor, type WatchHealth } from "./watchHealthState";
export type { WatchHealth } from "./watchHealthState";

let showing = false;
export const watchHealth = createWatchHealthMonitor({
  listen: (changed) =>
    getCurrentWebviewWindow().listen<WatchHealth>("watch:health", (event) =>
      changed(event.payload),
    ),
  read: () => invoke<WatchHealth>("watch_health"),
  retry: () => invoke<WatchHealth>("watch_retry"),
  present: (error, retry) => {
    if (!error) {
      if (showing) toast.dismiss("watch-health");
      showing = false;
      return;
    }
    showing = true;
    toast.error("Live file updates interrupted", {
      id: "watch-health",
      duration: Number.POSITIVE_INFINITY,
      description: `${error}. Editors, diffs and Source Control may be out of date.`,
      action: { label: "Retry", onClick: retry },
    });
  },
});
