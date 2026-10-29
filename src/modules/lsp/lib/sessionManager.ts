import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { OarlockLspClient } from "./client";
import { detectBinary } from "./detect";
import { getLspNavigator } from "./navigator";
import { type LspPreset, rootMarkersOf, serverForLanguage } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";
import { retireLspGeneration, type TauriLspTransport } from "./transport";
import { fileUriToPath, pathToFileUri } from "./uri";

const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAX_CRASHES = 3;
const SHUTDOWN_TIMEOUT_MS = 2000;
const MAX_SESSIONS_PER_PRESET = 4;
const CRASH_COOLDOWN_MS = [2_000, 10_000, 30_000];
const EVICTION_MIN_AGE_MS = 10_000;

type Managed = {
  key: string;
  preset: LspPreset;
  root: string;
  client: OarlockLspClient;
  transport: TauriLspTransport;
  refs: Map<string, number>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  bornAt: number;
};

export type LspDocHandle = {
  extension: Extension;
  release: () => void;
};

const sessions = new Map<string, Managed>();
const creating = new Map<string, Promise<Managed | null>>();
const generations = new Map<string, number>();
const pendingTransports = new Map<string, Set<TauriLspTransport>>();
function generation(presetId: string): number {
  return generations.get(presetId) ?? 0;
}
function current(preset: LspPreset, epoch: number): boolean {
  const prefs = usePreferencesStore.getState();
  return (
    generation(preset.id) === epoch &&
    prefs.lspActivation[preset.id] === "enabled"
  );
}
const stopped = new Set<string>();
const crashTimes = new Map<string, number[]>();

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function crashedOut(key: string): boolean {
  const now = Date.now();
  const times = (crashTimes.get(key) ?? []).filter(
    (t) => now - t < CRASH_WINDOW_MS,
  );
  crashTimes.set(key, times);
  return times.length >= MAX_CRASHES;
}

function recordCrash(key: string): void {
  const times = crashTimes.get(key) ?? [];
  times.push(Date.now());
  crashTimes.set(key, times);
}

export async function acquireDocExtension(
  path: string,
  langId: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<LspDocHandle | null> {
  if (workspace.kind !== "local") return null;
  const prefs = usePreferencesStore.getState();
  const preset = serverForLanguage(
    langId,
    prefs.lspCustomServers,
    prefs.lspActivation,
  );
  if (!preset) return null;
  if (prefs.lspActivation[preset.id] !== "enabled") return null;
  const epoch = generation(preset.id);
  if (!(await detectBinary(preset.command)) || !current(preset, epoch))
    return null;

  // No project root means no session: a per-directory fallback multiplied
  // servers per open file and burned gigabytes.
  const root = await invoke<string | null>("lsp_resolve_root", {
    path,
    markers: rootMarkersOf(preset),
  }).catch(() => null);
  if (!root || !current(preset, epoch)) return null;
  const key = `${preset.id}\u0000${root}`;
  if (stopped.has(key) || crashedOut(key)) return null;
  if (
    !sessions.has(key) &&
    !creating.has(key) &&
    [...new Set([...sessions.keys(), ...creating.keys()])].filter((key) =>
      key.startsWith(`${preset.id}\u0000`),
    ).length >= MAX_SESSIONS_PER_PRESET
  ) {
    console.warn(
      `[lsp] session cap reached for ${preset.id}, skipping ${root}`,
    );
    return null;
  }

  // Evict idle sessions of other roots; the age guard keeps simultaneous
  // multi-root opens from evicting each other's newborn sessions.
  if (!sessions.has(key)) {
    const now = Date.now();
    for (const m of sessions.values()) {
      if (
        m.preset.id === preset.id &&
        m.refs.size === 0 &&
        !m.closing &&
        now - m.bornAt > EVICTION_MIN_AGE_MS
      ) {
        void closeSession(m);
      }
    }
  }

  const managed =
    sessions.get(key) ?? (await getOrCreateSession(key, preset, root, epoch));
  if (!managed || !current(preset, epoch) || managed.closing) return null;

  const uri = pathToFileUri(path);
  const languageId = preset.languages[langId] ?? langId;
  const mod = await import("./client");
  if (!current(preset, epoch) || managed.closing) return null;
  const extension: Extension = [
    mod.lspInteractions({
      client: managed.client,
      documentUri: uri,
      rootPath: managed.root.replace(/\\/g, "/"),
      onExternal: (extUri, line) => {
        const target = fileUriToPath(extUri);
        if (target) getLspNavigator()?.openFile(target, line);
      },
    }),
    mod.languageServerWithTransport({
      client: managed.client,
      transport: managed.transport,
      rootUri: pathToFileUri(managed.root),
      workspaceFolders: [
        { uri: pathToFileUri(managed.root), name: basename(managed.root) },
      ],
      documentUri: uri,
      languageId,
      allowHTMLContent: false,
      synchronizationMethod: mod.SynchronizationMethod.Incremental,
    }) as Extension,
  ];

  addRef(managed, uri);
  let released = false;
  return {
    extension,
    release: () => {
      if (released) return;
      released = true;
      releaseRef(managed, uri);
    },
  };
}

function getOrCreateSession(
  key: string,
  preset: LspPreset,
  root: string,
  epoch: number,
): Promise<Managed | null> {
  let inflight = creating.get(key);
  if (!inflight) {
    inflight = createSession(key, preset, root, epoch).finally(() => {
      if (creating.get(key) === inflight) creating.delete(key);
    });
    creating.set(key, inflight);
  }
  return inflight;
}

async function createSession(
  key: string,
  preset: LspPreset,
  root: string,
  epoch: number,
): Promise<Managed | null> {
  const existing = sessions.get(key);
  if (existing) return existing;

  const store = useLspRuntimeStore.getState();
  store.upsertSession({ key, presetId: preset.id, root, status: "starting" });

  const [{ TauriLspTransport }, { OarlockLspClient }] = await Promise.all([
    import("./transport"),
    import("./client"),
  ]);

  if (OarlockLspClient.hostPid === null) {
    OarlockLspClient.hostPid = await invoke<number>("lsp_host_pid").catch(
      () => null,
    );
  }

  if (!current(preset, epoch)) return null;
  const transport = new TauriLspTransport();
  const pending =
    pendingTransports.get(preset.id) ?? new Set<TauriLspTransport>();
  pendingTransports.set(preset.id, pending);
  pending.add(transport);
  try {
    await transport.start({
      presetId: preset.id,
      generation: epoch,
      command: preset.command,
      args: preset.args,
      root,
      env: preset.env,
      maxMemoryMb: preset.maxMemoryMb,
    });
  } catch (e) {
    if (!current(preset, epoch)) return null;
    recordCrash(key);
    store.removeSession(key, preset.id);
    toast.error(`${preset.name} language server failed to start`, {
      description: String(e),
    });
    return null;
  } finally {
    pending.delete(transport);
    if (pending.size === 0 && pendingTransports.get(preset.id) === pending)
      pendingTransports.delete(preset.id);
  }
  if (!current(preset, epoch)) {
    transport.close();
    return null;
  }

  const rootUri = pathToFileUri(root);
  const client = new OarlockLspClient({
    transport,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: basename(root) }],
    documentUri: rootUri,
    languageId: "",
    initializationOptions: preset.initializationOptions,
    onClose: () => handleServerExit(key, transport),
    onError: (e) => console.error(`[lsp:${preset.id}]`, e),
  });

  const managed: Managed = {
    key,
    preset,
    root,
    client,
    transport,
    refs: new Map(),
    idleTimer: null,
    closing: false,
    bornAt: Date.now(),
  };
  sessions.set(key, managed);
  // Exit can beat the map insert when the binary dies instantly (e.g. a
  // rustup proxy for an uninstalled component); reap it here.
  if (transport.exitInfo) {
    handleServerExit(key, transport);
    return null;
  }

  void client.initializePromise.then(() => {
    if (sessions.get(key) === managed) {
      // The library reports initialize errors via onError and resolves this
      // promise anyway. Resolution alone does not mean initialization succeeded.
      if (!client.ready) {
        toast.error(`${preset.name} language server failed to initialize`);
        handleServerExit(key, transport);
        return;
      }
      const runtime = useLspRuntimeStore.getState();
      if (![...stopped].some((key) => key.startsWith(`${preset.id}\u0000`)))
        runtime.clearFailed(preset.id);
      runtime.upsertSession({
        key,
        presetId: preset.id,
        root,
        status: "running",
      });
    }
  });

  return managed;
}

function handleServerExit(key: string, transport: TauriLspTransport): void {
  const managed = sessions.get(key);
  if (!managed || managed.closing || managed.transport !== transport) return;
  managed.closing = true;
  if (managed.idleTimer) clearTimeout(managed.idleTimer);
  recordCrash(key);
  sessions.delete(key);
  managed.client.close();
  useLspRuntimeStore.getState().removeSessionQuiet(key);
  const info = managed.transport.exitInfo;
  // Budget kills don't respawn: reloading would repay the startup peak
  // that got the server killed. Restart from the pill is explicit.
  if (info?.reason) {
    stopped.add(key);
    useLspRuntimeStore.getState().setFailed(managed.preset.id, info.reason);
    toast.error(`${managed.preset.name} language server stopped`, {
      description: info.reason,
    });
    return;
  }
  const tail = info?.stderrTail;
  if (crashedOut(key)) {
    useLspRuntimeStore
      .getState()
      .setFailed(
        managed.preset.id,
        tail ? tail.slice(-300) : "The server kept crashing.",
      );
    toast.error(`${managed.preset.name} language server keeps crashing`, {
      description: tail ? tail.slice(-300) : "Giving up for this workspace.",
    });
    return;
  }
  if (tail) {
    toast.error(`${managed.preset.name} language server exited`, {
      description: tail.slice(-300),
    });
  }
  // Delay the re-acquire trigger so an OOM-killed server doesn't respawn
  // into an instant second memory spike.
  const crashes = crashTimes.get(key)?.length ?? 1;
  const delay =
    CRASH_COOLDOWN_MS[Math.min(crashes - 1, CRASH_COOLDOWN_MS.length - 1)];
  const epoch = generation(managed.preset.id);
  setTimeout(() => {
    if (current(managed.preset, epoch))
      useLspRuntimeStore.getState().bumpGeneration(managed.preset.id);
  }, delay);
}

function addRef(managed: Managed, uri: string): void {
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
  }
  managed.refs.set(uri, (managed.refs.get(uri) ?? 0) + 1);
}

function releaseRef(managed: Managed, uri: string): void {
  const count = managed.refs.get(uri);
  if (count === undefined) return;
  if (count > 1) {
    managed.refs.set(uri, count - 1);
    return;
  }
  managed.refs.delete(uri);
  if (!managed.closing) managed.client.textDocumentDidClose(uri);
  if (managed.refs.size === 0 && !managed.closing) {
    managed.idleTimer = setTimeout(() => {
      void closeSession(managed);
    }, IDLE_SHUTDOWN_MS);
  }
}

async function closeSession(managed: Managed): Promise<void> {
  if (managed.closing) return;
  managed.closing = true;
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
  }
  sessions.delete(managed.key);
  useLspRuntimeStore.getState().removeSession(managed.key, managed.preset.id);
  try {
    await managed.client.shutdownGracefully(SHUTDOWN_TIMEOUT_MS);
  } finally {
    managed.transport.close();
  }
}

export function notifyDocumentSaved(path: string): void {
  const uri = pathToFileUri(path);
  for (const managed of sessions.values()) {
    if (managed.refs.has(uri) && !managed.closing) {
      managed.client.textDocumentDidSave(uri);
    }
  }
}

async function stopPresetSessions(presetId: string): Promise<void> {
  for (const key of stopped) {
    if (key.startsWith(`${presetId}\u0000`)) stopped.delete(key);
  }
  const epoch = generation(presetId) + 1;
  generations.set(presetId, epoch);
  for (const transport of pendingTransports.get(presetId) ?? [])
    transport.close();
  for (const key of creating.keys()) {
    if (key.startsWith(`${presetId}\u0000`)) {
      creating.delete(key);
      useLspRuntimeStore.getState().removeSession(key, presetId);
    }
  }
  // Native also rejects old starts queued behind this invalidation.
  const targets = [...sessions.values()].filter(
    (m) => m.preset.id === presetId,
  );
  const closing = targets.map((m) => closeSession(m));
  await Promise.all([retireLspGeneration(presetId, epoch), ...closing]);
  for (const key of crashTimes.keys()) {
    if (key.startsWith(`${presetId}\u0000`)) crashTimes.delete(key);
  }
}

export async function lspFormatDocument(
  view: EditorView,
  current: () => boolean = () => true,
): Promise<"done" | "unsupported"> {
  if (sessions.size === 0) return "unsupported";
  const { formatDocumentAndWait } = await import("./client");
  if (!current()) return "done";
  return formatDocumentAndWait(view, current);
}

// Open docs re-acquire automatically via the generation bump, so a stop
// while still enabled is a restart.
export async function restartPresetSessions(presetId: string): Promise<void> {
  await stopPresetSessions(presetId);
  const store = useLspRuntimeStore.getState();
  store.clearFailed(presetId);
  store.bumpGeneration(presetId);
}

// Disabling can happen in the Settings window; sessions live here. React to
// the mirrored preference change instead of a direct call.
usePreferencesStore.subscribe((state, prev) => {
  if (
    state.lspActivation === prev.lspActivation &&
    state.lspCustomServers === prev.lspCustomServers &&
    state.terminalShell === prev.terminalShell
  )
    return;
  const ids = new Set([
    ...Object.keys(state.lspActivation),
    ...Object.keys(prev.lspActivation),
  ]);
  for (const id of ids) {
    const changed =
      state.lspActivation[id] !== prev.lspActivation[id] ||
      state.terminalShell !== prev.terminalShell ||
      JSON.stringify(state.lspCustomServers.find((s) => s.id === id)) !==
        JSON.stringify(prev.lspCustomServers.find((s) => s.id === id));
    if (changed)
      void restartPresetSessions(id).catch((e) =>
        console.error("[lsp] restart failed", e),
      );
  }
});
