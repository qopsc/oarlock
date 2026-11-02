import type { CustomEndpoint } from "@/modules/ai/config";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Snapshot = { revision: number; endpoints: CustomEndpoint[] };
type Patch = Partial<Omit<CustomEndpoint, "id">>;
// Only live preference observers participate in manual recovery. No timer or
// background retry; a failed listener can reconnect when the user clicks Retry.
const observers = new Set<{
  connect: () => Promise<void>;
  accept: (snapshot: Snapshot) => void;
}>();
export async function loadCustomEndpoints(): Promise<CustomEndpoint[]> {
  return (await invoke<Snapshot>("ai_endpoints_snapshot")).endpoints;
}
// Recovery also reaches other windows that could not load the file. Deliver it
// through the revision-checked subscription, never directly into UI state.
export async function retryCustomEndpoints(): Promise<void> {
  const active = [...observers];
  await Promise.all(active.map((observer) => observer.connect()));
  const snapshot = await invoke<Snapshot>("ai_endpoints_snapshot", {
    refresh: true,
  });
  for (const observer of active) observer.accept(snapshot);
}
export async function createCustomEndpoint(
  endpoint: CustomEndpoint,
): Promise<void> {
  const { id: _, ...fields } = endpoint;
  await invoke("ai_endpoints_mutate", {
    change: { kind: "create", endpoint: fields },
  });
}
export async function updateCustomEndpoint(
  id: string,
  patch: Patch,
): Promise<void> {
  await invoke("ai_endpoints_mutate", {
    change: { kind: "update", id, patch },
  });
}
export async function deleteCustomEndpoint(id: string): Promise<void> {
  await invoke("ai_endpoints_mutate", { change: { kind: "delete", id } });
}
export async function onCustomEndpoints(
  changed: (endpoints: CustomEndpoint[]) => void,
  failed: (error: unknown) => void,
): Promise<UnlistenFn> {
  let revision = -1;
  let alive = true;
  const accept = (snapshot: Snapshot) => {
    if (!alive || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    changed(snapshot.endpoints);
  };
  let stop: UnlistenFn | undefined;
  let connecting: Promise<void> | undefined;
  const connect = (): Promise<void> => {
    if (!alive || stop) return Promise.resolve();
    connecting ??= listen<Snapshot>("oarlock://endpoints-changed", (e) =>
      accept(e.payload),
    )
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  };
  const observer = { connect, accept };
  observers.add(observer);
  // Events may arrive while this read is pending. Its revision must not undo
  // them; registering first also closes the startup snapshot/listener gap.
  try {
    await connect();
    accept(await invoke<Snapshot>("ai_endpoints_snapshot"));
  } catch (error) {
    if (revision < 0) failed(error);
  }
  return () => {
    alive = false;
    observers.delete(observer);
    stop?.();
  };
}
