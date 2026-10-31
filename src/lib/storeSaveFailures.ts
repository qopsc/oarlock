import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

/** Install before stores load so background write failures are not missed. */
export async function installStoreSaveFailureReporting(): Promise<void> {
  try {
    await listen<string>("oarlock://store-save-failed", ({ payload }) => {
      toast.error("Could not save application data", {
        description: payload,
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
      });
    });
  } catch (error) {
    toast.error("Could not monitor application data saves", {
      description: String(error),
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
    });
  }
}
