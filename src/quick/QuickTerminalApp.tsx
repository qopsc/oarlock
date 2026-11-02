import { TooltipProvider } from "@/components/ui/tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { disposeSession, TerminalPromptDialog } from "@/modules/terminal";
import { TerminalPane } from "@/modules/terminal/TerminalPane";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The quick terminal's page: one terminal filling a borderless window that a
 * global hotkey drops down and puts away (`quick_terminal.rs`). Hiding keeps
 * the shell; when the shell exits the window hides and the next show starts a
 * new one in the home directory.
 */
export function QuickTerminalApp() {
  // The pane picks its renderer from the preferences when it mounts.
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const autohide = usePreferencesStore(
    (state) => state.terminalBehavior.quickTerminalAutohide,
  );
  const [leafId, setLeafId] = useState<number | null>(1);
  const lastLeafId = useRef(1);
  const restartOnFocus = useRef(false);
  const [focused, setFocused] = useState(true);
  const autohideRef = useRef(autohide);
  autohideRef.current = autohide;

  useEffect(() => {
    void usePreferencesStore.getState().init();
  }, []);

  useEffect(() => {
    const window = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void window
      .onFocusChanged(({ payload: hasFocus }) => {
        setFocused(hasFocus);
        if (hasFocus && restartOnFocus.current) {
          restartOnFocus.current = false;
          setLeafId(++lastLeafId.current);
        }
        if (!hasFocus && autohideRef.current) void window.hide();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const onExit = useCallback(() => {
    if (leafId === null) return;
    disposeSession(leafId);
    restartOnFocus.current = true;
    setLeafId(null);
    void getCurrentWindow().hide();
  }, [leafId]);

  return (
    <TooltipProvider>
      <main className="h-screen w-screen overflow-hidden bg-background p-1.5">
        {hydrated && leafId !== null ? (
          <TerminalPane
            key={leafId}
            leafId={leafId}
            visible
            focused={focused}
            onExit={onExit}
          />
        ) : null}
      </main>
      <TerminalPromptDialog />
    </TooltipProvider>
  );
}
