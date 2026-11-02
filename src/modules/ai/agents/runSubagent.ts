import { generateText, isStepCount } from "ai";
import { buildConfiguredLanguageModel } from "../lib/agent";
import type { ProviderKeys } from "../lib/keyring";
import type { LocalProviderConfig } from "../lib/modelTarget";
import { type TokenUsage, tokenUsage } from "../lib/usage";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { TOOL_APPROVAL } from "../tools/tools";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  assertReady?: () => void;
  abortSignal?: AbortSignal;
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  /** The chat's model id: a catalog model, a local server or an endpoint. */
  modelId: string;
  /** What that id resolves against (local servers, custom endpoints). */
  config: LocalProviderConfig;
  toolContext: ToolContext;
  onStep?: (label: string) => void;
  /** Each step's usage on the user's key, with the model id it ran on
   *  (`modelId`, which prices it). */
  onUsage?: (modelId: string, usage: TokenUsage) => void;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  assertReady,
  abortSignal,
  type,
  prompt,
  keys,
  modelId,
  config,
  toolContext,
  onStep,
  onUsage,
}: Args): Promise<RunResult> {
  abortSignal?.throwIfAborted();
  assertReady?.();
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // Fresh messages require fresh read history. Neither the parent nor another
  // subagent has shown its file contents to this model call.
  const context = { ...toolContext, readCache: new Map() };
  const readOnly: Record<string, unknown> = {
    ...buildFsTools(context),
    ...buildSearchTools(context),
  };
  const tools: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) tools[t] = readOnly[t];
  }

  const model = await buildConfiguredLanguageModel(modelId, keys, config);

  const start = Date.now();
  abortSignal?.throwIfAborted();
  assertReady?.();
  const result = await generateText({
    abortSignal,
    model,
    instructions: def.systemPrompt,
    prompt,
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    // Subagents only get read-only tools, but the shared policy still
    // applies: a mutating tool whitelisted by mistake stops for approval
    // (which a subagent cannot get) instead of running.
    toolApproval: TOOL_APPROVAL,
    maxOutputTokens: 8192,
    stopWhen: isStepCount(SUBAGENT_MAX_STEPS),
    onStepEnd: (step) => {
      if (onUsage && step.usage) onUsage(modelId, tokenUsage(step.usage));
      if (!onStep) return;
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) onStep(`${type}: ${last.toolName}`);
    },
  });

  return {
    summary: result.text || "(no output)",
    stepCount: result.steps?.length ?? 0,
    durationMs: Date.now() - start,
  };
}
