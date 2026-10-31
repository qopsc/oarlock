import { writeClipboardText } from "@/lib/clipboardWrite";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { redetectBinary, type LspPreset } from "@/modules/lsp";
import { setLspActivation } from "@/modules/settings/store";
import {
  Copy01Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { recheckLspInstall } from "./lspInstallRecheck";

type Props = {
  server: LspPreset | null;
  onClose: () => void;
};

export function LspInstallDialog({ server, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  const savingRef = useRef(false);
  const serverId = useRef(server?.id);
  if (serverId.current !== server?.id) {
    serverId.current = server?.id;
    attempt.current++;
  }

  useEffect(() => () => { attempt.current++; }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!server) return null;

  const copyInstallCommand = async () => {
    if (!server.install) return;
    try {
      await writeClipboardText(server.install.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const checkAgain = async () => {
    const owner = ++attempt.current;
    const current = () => attempt.current === owner && serverId.current === server.id;
    setChecking(true);
    setNotFound(false);
    setError(null);
    try {
      const result = await recheckLspInstall(current, () => redetectBinary(server.command), () => {
        savingRef.current = true;
        setSaving(true);
      }, () => setLspActivation(server.id, "enabled"));
      if (result === "saved") onClose();
      else if (result === "missing") setNotFound(true);
    } catch (error) {
      if (current()) setError(`Could not enable the language server: ${String(error)}`);
    } finally {
      if (current()) {
        savingRef.current = false;
        setSaving(false);
        setChecking(false);
      }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !savingRef.current) { attempt.current++; onClose(); } }}>
      <DialogContent className="max-w-md" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Install {server.name} language server</DialogTitle>
          <DialogDescription>
            Oarlock could not find{" "}
            <code className="font-mono text-foreground">{server.command}</code>{" "}
            on your PATH. Install it, then check again to enable this language
            server.
          </DialogDescription>
        </DialogHeader>

        {server.install ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px]">
            <span className="min-w-0 flex-1 select-text break-all">
              {server.install.command}
            </span>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void copyInstallCommand()}
              title="Copy install command"
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                size={13}
                strokeWidth={2}
              />
            </button>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Install this custom server manually and make sure its command is
            available on PATH.
          </p>
        )}

        {notFound ? (
          <p className="text-xs text-destructive">
            Still not found. Finish the installation and make sure the command
            is available on PATH.
          </p>
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="items-center sm:justify-between">
          {server.install ? (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() =>
                void openUrl(server.install?.docsUrl ?? "").catch(console.error)
              }
            >
              Documentation
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={checking}
            onClick={() => void checkAgain()}
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              size={12}
              strokeWidth={1.9}
              className={checking ? "animate-spin" : undefined}
            />
            {saving ? "Saving…" : checking ? "Checking..." : "Check again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
