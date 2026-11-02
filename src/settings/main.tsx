import { installClipboardCopyBarrier } from "@/lib/clipboardWrite";
import "../styles/globals.css";

import { installNativeContextMenuGuard } from "@/lib/nativeContextMenu";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { installWindowFrame } from "@/lib/windowFrame";
import { ThemeProvider } from "@/modules/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./SettingsApp";
import { Toaster } from "@/components/ui/sonner";
import { installStoreSaveFailureReporting } from "@/lib/storeSaveFailures";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}
installNativeContextMenuGuard();
installClipboardCopyBarrier();
installWindowFrame();
await installStoreSaveFailureReporting();

ReactDOM.createRoot(
  document.getElementById("settings-root") as HTMLElement,
).render(
  <ThemeProvider>
    <SettingsApp />
    <Toaster position="bottom-right" />
  </ThemeProvider>,
);

const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("settings show failed:", e));
};
setTimeout(showWindow, 50);
setTimeout(showWindow, 500);
