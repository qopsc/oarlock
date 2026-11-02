import { useEffect, useState } from "react";
import { toast } from "sonner";
import { firePendingReviewForSession } from "@/modules/agents/lib/review";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import {
  getAllCustomEndpointKeys,
  getAllKeys,
  hasAnyKey,
  hasUnavailableProviderKeys,
  pendingProviderKeys,
  pendingEndpointKeys,
} from "../lib/keyring";
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

/**
 * Startup wiring for the AI subsystem: loads provider keys (and keeps them in
 * sync), hydrates the preference store and mirrors the default model, hydrates
 * chat/agents/snippets stores, and fires any pending review for the active
 * session. Returns the two derived flags the shell needs.
 */
export function useAiBootstrap(): {
  hasComposer: boolean;
  keysLoaded: boolean;
} {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setCustomEndpointKeys = useChatStore((s) => s.setCustomEndpointKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);

  useEffect(() => {
    if (activeSessionId) firePendingReviewForSession(activeSessionId);
  }, [activeSessionId]);

  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);
  const hasLocalModel =
    (lmstudioBaseURL.trim().length > 0 && lmstudioModelId.trim().length > 0) ||
    (mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0) ||
    (ollamaBaseURL.trim().length > 0 && ollamaModelId.trim().length > 0) ||
    customEndpoints.some(
      (e) => e.baseURL.trim().length > 0 && e.modelId.trim().length > 0,
    );
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const hasComposer =
    hasAnyKey(apiKeys) ||
    hasLocalModel ||
    (keysLoaded && hasUnavailableProviderKeys(apiKeys));
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let endpointGeneration = 0;
    let watching = false;
    let endpoints = usePreferencesStore.getState().customEndpoints;
    const reloadEndpoints = () => {
      endpoints = usePreferencesStore.getState().customEndpoints;
      const request = ++endpointGeneration;
      setCustomEndpointKeys(pendingEndpointKeys(endpoints));
      if (!prefsHydrated) return;
      void getAllCustomEndpointKeys(endpoints).then((epKeys) => {
        if (!alive || request !== endpointGeneration) return;
        setCustomEndpointKeys(epKeys);
      });
    };
    const reload = () => {
      const request = ++generation;
      setApiKeys(pendingProviderKeys());
      void getAllKeys().then((keys) => {
        if (!alive || request !== generation) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
      reloadEndpoints();
    };
    setApiKeys(pendingProviderKeys());
    setCustomEndpointKeys(pendingEndpointKeys(endpoints));
    // Recovering endpoint metadata does not change keychain entries and emits
    // no key event. Watch identities only: renames/URL edits need no key read.
    const stopPreferences = usePreferencesStore.subscribe(() => {
      if (!watching) return;
      const next = usePreferencesStore.getState().customEndpoints;
      const changed =
        next.length !== endpoints.length ||
        next.some((endpoint, i) => endpoint.id !== endpoints[i].id);
      endpoints = next;
      if (changed) reloadEndpoints();
    });
    // Subscribe before taking the snapshot: a deletion during registration
    // must be reflected by the first read even if its event was missed.
    const unlistenP = onKeysChanged(reload);
    void unlistenP.then(
      () => {
        if (alive) {
          watching = true;
          reload();
        }
      },
      (error) => {
        if (alive) {
          const failed = { status: "failed" as const, error: String(error) };
          setApiKeys(pendingProviderKeys(failed));
          setCustomEndpointKeys(pendingEndpointKeys(endpoints, failed));
          setKeysLoaded(true);
          toast.error("Could not watch API key changes", {
            description: String(error),
          });
        }
      },
    );
    return () => {
      alive = false;
      stopPreferences();
      void unlistenP.then(
        (fn) => fn(),
        () => {},
      );
    };
  }, [setApiKeys, setCustomEndpointKeys, prefsHydrated]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setSelectedModelId(prefDefaultModel);
  }, [prefsHydrated, prefDefaultModel, setSelectedModelId]);

  useEffect(() => {
    void hydrateSessions().catch((error: unknown) => {
      toast.error("Could not load chat history", {
        id: "chat-history-load",
        description: String(error),
      });
    });
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
  }, [hydrateSessions]);

  return { hasComposer, keysLoaded };
}
