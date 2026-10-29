import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listEndpointModels } from "@/modules/ai/lib/endpointModels";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; models: string[] }
  | { status: "error"; message: string };

/** Lists the models an OpenAI-compatible server offers (`GET <base>/models`),
 *  so a model id can be picked instead of typed. Fetched when opened, and
 *  again on Refresh or when the base URL changed. */
export function ModelBrowseButton({
  baseURL,
  disabled = false,
  apiKey,
  onSelect,
}: {
  disabled?: boolean;
  baseURL: string;
  apiKey?: string | null;
  onSelect: (modelId: string) => void;
}) {
  // A new identity invalidates results even when props change away and back.
  const context = useMemo(
    () => ({ baseURL, apiKey, disabled }),
    [baseURL, apiKey, disabled],
  );
  const [result, setResult] = useState<{
    context: typeof context;
    state: ListState;
  } | null>(null);
  const state: ListState =
    result?.context === context ? result.state : { status: "idle" };
  const request = useRef(0);
  const pending = useRef<{
    context: typeof context;
    controller: AbortController;
  } | null>(null);
  useEffect(
    () => () => {
      if (pending.current?.context === context) {
        ++request.current;
        pending.current.controller.abort();
      }
    },
    [context],
  );

  const load = async () => {
    if (disabled) return;
    pending.current?.controller.abort();
    const controller = new AbortController();
    pending.current = { context, controller };
    const id = ++request.current;
    const setState = (state: ListState) => setResult({ context, state });
    setState({ status: "loading" });
    try {
      const models = await listEndpointModels(
        baseURL,
        apiKey,
        undefined,
        controller.signal,
      );
      if (id === request.current && !controller.signal.aborted) {
        setState({ status: "ready", models });
      }
    } catch (error) {
      if (id === request.current && !controller.signal.aborted) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const onOpenChange = (open: boolean) => {
    if (!open || disabled) return;
    if (state.status === "ready") return;
    void load();
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !baseURL.trim()}
          className="h-8 shrink-0 px-2.5 text-[11px]"
          title="Pick from the models this server lists"
        >
          Browse
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-1">
        <div className="flex items-center justify-between px-2 pt-0.5 pb-1">
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Available models
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => void load()}
            disabled={disabled || state.status === "loading"}
            aria-label="Refresh"
            title="Refresh"
          >
            <HugeiconsIcon icon={RefreshIcon} />
          </Button>
        </div>
        {!disabled && state.status === "ready" && state.models.length > 0 ? (
          <div className="max-h-64 overflow-y-auto overscroll-contain">
            {state.models.map((id) => (
              <DropdownMenuItem
                key={id}
                onSelect={() => onSelect(id)}
                className="font-mono text-[11.5px] break-all"
              >
                {id}
              </DropdownMenuItem>
            ))}
          </div>
        ) : (
          <div
            className={
              state.status === "error"
                ? "px-2 py-2 text-[11px] wrap-break-word text-destructive/80 select-text"
                : "px-2 py-2 text-[11px] text-muted-foreground"
            }
          >
            {disabled
              ? "Resolve endpoint credentials before browsing."
              : state.status === "idle"
                ? "Refresh to list models for this endpoint."
                : state.status === "error"
                  ? `Could not list models: ${state.message}`
                  : state.status === "ready"
                    ? "The server lists no models."
                    : "Loading…"}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
