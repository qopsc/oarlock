import { holdMcpRun, type RunLease } from "./mcpRunLeases";
import {
  denyUnansweredApprovals,
  EXPIRED_APPROVAL_REASON,
} from "./toolApprovals";
import { ownedStream } from "./ownedStream";
import { beginChatWork } from "./chatWork";
import { assertWorkspaceAvailable } from "@/modules/workspace/availability";
import { assertChatCanStart } from "../store/chatStop";
import { currentWorkspaceEnv } from "@/modules/workspace/env";
import { mcpToolsForRun } from "@/modules/mcp";
import type { UIMessage } from "@ai-sdk/react";
import { toUIMessageStream } from "ai";
import type { AgentSkills } from "@/modules/skills/catalog";
import { type CustomEndpoint, resolveContextLimit } from "../config";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { maxMemoryBytes } from "./compact";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { formatAiError } from "./errors";
import { pathText } from "./messageBlocks";
import { native, createNative, type ProjectMemory } from "./native";
import type { ToolContext } from "../tools/tools";
import type { ApprovalMode } from "./approvalMode";
import type { ReasoningEffort } from "./reasoningEffort";

/**
 * The project's AGENTS.md for this run. The backend reads it and returns it only
 * while the user allows its current content (project trust), so it is asked on
 * every run: a withdrawn answer or a changed file stops reaching the model at
 * once. Without it the run goes on with no project memory. The whole file is
 * sent, whatever its size; above `limit` bytes (more than the model could take)
 * only its size comes back, and the run says it does not fit.
 */
async function readAgentsMd(
  workspaceRoot: string | null,
  limit: number,
  client = native,
): Promise<ProjectMemory | null> {
  if (!workspaceRoot) return null;
  try {
    return await client.readProjectMemory(workspaceRoot, limit);
  } catch {
    return null;
  }
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

type Deps = {
  assertReady: () => void;
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  captureToolContext?: () => ToolContext;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getMlxBaseURL?: () => string | undefined;
  getMlxModelId?: () => string | undefined;
  getOllamaBaseURL?: () => string | undefined;
  getOllamaModelId?: () => string | undefined;
  getOpenrouterModelId?: () => string | undefined;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  getPlanMode?: () => boolean;
  /** The conversation's approval mode, read on every gated tool call. */
  getApprovalMode?: () => ApprovalMode;
  /** The effort remembered for the run's model, if one was chosen. */
  getReasoningEffort?: () => ReasoningEffort | undefined;
  /** The skills a run in this workspace may use. */
  getSkills?: (
    workspaceRoot: string | null,
    workspace: import("@/modules/workspace/env").WorkspaceEnv,
  ) => Promise<AgentSkills>;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  let pendingApprovalLease: RunLease | undefined;
  let cacheScope = "";
  let readCache = deps.toolContext.readCache;
  let binding:
    | {
        userId: string | undefined;
        live: LiveSnapshot;
        toolContext: ToolContext &
          Required<Pick<ToolContext, "native" | "workspace">>;
      }
    | undefined;
  const run = async (options: SendOptions) => {
    // Keep a waiting approval lease intact when admission is refused.
    deps.assertReady();
    const chatId = deps.toolContext.getSessionId?.();
    const previousLease = pendingApprovalLease;
    pendingApprovalLease = undefined;
    let lease: RunLease | undefined;
    let mcpPromise: ReturnType<typeof mcpToolsForRun> | undefined;
    let transferred = false;
    const finishRunWork = beginChatWork(chatId ?? null);
    try {
      const last = options.messages[options.messages.length - 1];
      if (!binding && last?.role === "assistant") {
        const tail = [last];
        if (denyUnansweredApprovals(tail) !== tail)
          throw new Error(EXPIRED_APPROVAL_REASON);
      }
      const userId = [...options.messages]
        .reverse()
        .find((m) => m.role === "user")?.id;
      if (!binding || binding.userId !== userId) {
        const live = { ...deps.getLive() };
        const workspace = currentWorkspaceEnv();
        const scope = JSON.stringify([workspace, live.workspaceRoot]);
        if (scope !== cacheScope) {
          cacheScope = scope;
          readCache = new Map();
        }
        const captured = deps.captureToolContext?.() ?? deps.toolContext;
        const terminal = captured.getTerminalContext();
        binding = {
          userId,
          live,
          toolContext: {
            ...captured,
            native: createNative(() => workspace),
            workspace,
            getCwd: () => live.cwd,
            getWorkspaceRoot: () => live.workspaceRoot,
            getTerminalContext: deps.captureToolContext
              ? captured.getTerminalContext
              : () => terminal,
            isActiveTerminalPrivate: deps.captureToolContext
              ? captured.isActiveTerminalPrivate
              : () => live.terminalPrivate,
            readCache,
          },
        };
      }
      // Approval continuations belong to the original user turn, even after navigation.
      const { live, toolContext } = binding;
      const workspace = toolContext.workspace;
      assertWorkspaceAvailable(workspace);
      const client = toolContext.native;
      const contextLimit = resolveContextLimit(
        deps.getModelId(),
        deps.getCustomEndpoints?.() ?? [],
      );
      // A continuation cannot replace the original project's MCP tools with those
      // of a newly selected space. Dispatch still rechecks current permissions.
      const admission = chatId ? assertChatCanStart(chatId) : Promise.resolve();
      mcpPromise = mcpToolsForRun({
        root: live.workspaceRoot,
        workspace,
        admission,
        ownLease: (release) => {
          lease = holdMcpRun(chatId ?? null, release);
          return lease.release;
        },
        signal: options.abortSignal,
        onWaiting: () => deps.onStep?.("Starting MCP servers"),
      });
      await admission;
      options.abortSignal?.throwIfAborted();
      deps.assertReady();
      const [projectMemory, mcp, skills] = await Promise.all([
        readAgentsMd(live.workspaceRoot, maxMemoryBytes(contextLimit), client),
        mcpPromise,
        deps.getSkills?.(live.workspaceRoot, workspace),
      ]);
      if (mcp?.release) lease ??= holdMcpRun(chatId ?? null, mcp.release);
      // Acquire the continuation's lease before releasing the approval pause's.
      await previousLease?.release();
      options.abortSignal?.throwIfAborted();
      deps.assertReady();
      const envBlock = formatEnvBlock(live);
      const messagesForRun = envBlock
        ? injectEnvIntoLastUser(options.messages, envBlock)
        : options.messages;
      const run = await runAgentStream({
        assertReady: deps.assertReady,
        keys: deps.getKeys(),
        modelId: deps.getModelId(),
        customInstructions: deps.getCustomInstructions(),
        agentPersona: deps.getAgentPersona(),
        toolContext,
        onStep: deps.onStep,
        onUsage: deps.onUsage,
        onCompact: deps.onCompact,
        onFinishMeta: deps.onFinishMeta,
        lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
        lmstudioModelId: deps.getLmstudioModelId?.(),
        mlxBaseURL: deps.getMlxBaseURL?.(),
        mlxModelId: deps.getMlxModelId?.(),
        ollamaBaseURL: deps.getOllamaBaseURL?.(),
        ollamaModelId: deps.getOllamaModelId?.(),
        openrouterModelId: deps.getOpenrouterModelId?.(),
        customEndpoints: deps.getCustomEndpoints?.(),
        customEndpointKeys: deps.getCustomEndpointKeys?.(),
        planMode: deps.getPlanMode?.(),
        approvalState: () => ({
          mode: deps.getApprovalMode?.() ?? "ask",
          planMode: deps.getPlanMode?.() ?? false,
        }),
        reasoningEffort: deps.getReasoningEffort?.(),
        projectMemory,
        mcp,
        skills,
        uiMessages: messagesForRun,
        abortSignal: options.abortSignal,
      });
      const stream = toUIMessageStream({
        stream: run.stream,
        tools: run.tools,
        originalMessages: options.messages,
        onError: formatAiError,
      });
      if (!mcp?.release || !lease) return stream;
      const ownedLease = lease;
      const approvals = new Set<string>();
      let failed = false;
      const owned = ownedStream(
        stream,
        async (reason) => {
          try {
            if (
              reason === "complete" &&
              approvals.size &&
              !failed &&
              !options.abortSignal?.aborted
            ) {
              pendingApprovalLease = ownedLease;
            } else await ownedLease.release();
          } finally {
            finishRunWork();
          }
        },
        options.abortSignal,
        (chunk) => {
          if (chunk.type === "tool-approval-request")
            approvals.add(chunk.toolCallId);
          else if (
            chunk.type === "tool-output-available" ||
            chunk.type === "tool-output-error" ||
            chunk.type === "tool-output-denied"
          )
            approvals.delete(chunk.toolCallId);
          else if (chunk.type === "error" || chunk.type === "abort")
            failed = true;
        },
      );
      transferred = true;
      return owned;
    } finally {
      try {
        if (!transferred) {
          const prepared = await mcpPromise;
          lease ??= prepared?.release
            ? holdMcpRun(chatId ?? null, prepared.release)
            : undefined;
          await Promise.all([lease?.release(), previousLease?.release()]);
        }
      } finally {
        if (!transferred) finishRunWork();
      }
    }
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let textIdx = -1;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === "text") {
        textIdx = j;
        break;
      }
    }
    const nextParts =
      textIdx === -1
        ? [{ type: "text", text: envBlock }, ...parts]
        : parts.map((p, idx) =>
            idx === textIdx
              ? { ...p, text: `${envBlock}\n\n${p.text ?? ""}` }
              : p,
          );
    const out = messages.slice();
    out[i] = { ...m, parts: nextParts } as UIMessage;
    return out;
  }
  return messages;
}

/** The run's environment for the model. A path is a folder or file name the
 *  user did not type, so it may hold a newline or `</env>`: each stays on its
 *  own line (`pathText`). */
function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) {
    lines.push(`workspace_root: ${pathText(live.workspaceRoot)}`);
  }
  if (live.cwd) lines.push(`active_terminal_cwd: ${pathText(live.cwd)}`);
  if (live.activeFile) lines.push(`active_file: ${pathText(live.activeFile)}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}
