import { requireCurrentPreferences } from "@/modules/settings/readiness";
import { beginChatWork } from "../lib/chatWork";
import { toast } from "sonner";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  initializeTasks,
  registerTask,
  taskCommand,
  taskOwner,
} from "../store/subagentTasks";
import { runSubagent } from "./runSubagent";

type Args = Parameters<typeof runSubagent>[0] & {
  sessionId: string;
  title: string;
};
export async function runTrackedSubagent(args: Args) {
  const ready = beginChatWork(args.sessionId);
  try {
    return await runTracked(args, ready);
  } finally {
    ready();
  }
}
async function runTracked(args: Args, ready: () => void) {
  args.abortSignal?.throwIfAborted();
  requireCurrentPreferences();
  await initializeTasks();
  const token = await taskOwner();
  args.abortSignal?.throwIfAborted();
  requireCurrentPreferences();
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const unregister = registerTask(id, controller);
  const cancelWithParent = () => {
    if (usePreferencesStore.getState().aiStopSubagents !== false)
      controller.abort();
  };
  args.abortSignal?.addEventListener("abort", cancelWithParent, { once: true });
  let inputTokens = 0,
    outputTokens = 0;
  let queue = Promise.resolve();
  let lastError: unknown;
  let lastRequest: Record<string, unknown> = {};
  const update = (
    status: string,
    step: string | null = null,
    result: string | null = null,
    error: string | null = null,
  ) => {
    const request = {
      action: "update",
      token,
      id,
      status,
      step,
      result,
      error,
      inputTokens,
      outputTokens,
    };
    lastRequest = request;
    queue = queue.then(async () => {
      try {
        await taskCommand(request);
        lastError = undefined;
      } catch (e) {
        lastError = e;
      }
    });
    return queue;
  };
  let started = false;
  try {
    await taskCommand({
      action: "start",
      token,
      id,
      sessionId: args.sessionId,
      title: args.title,
      kind: args.type,
      modelId: args.modelId,
      prompt: args.prompt,
    });
    started = true;
    if (args.abortSignal?.aborted) cancelWithParent();
    controller.signal.throwIfAborted();
    ready(); // Running subagents are settled separately, respecting their setting.
    const result = await runSubagent({
      ...args,
      assertReady: requireCurrentPreferences,
      abortSignal: controller.signal,
      onStep: (label) => {
        void update("running", label);
        if (!args.abortSignal?.aborted) args.onStep?.(label);
      },
      onUsage: (model, usage) => {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        args.onUsage?.(model, usage);
      },
    });
    await update("completed", null, result.summary);
    return { ...result, taskId: id };
  } catch (error) {
    if (started)
      await update(
        controller.signal.aborted ? "cancelled" : "failed",
        null,
        null,
        String(error),
      );
    throw error;
  } finally {
    unregister();
    args.abortSignal?.removeEventListener("abort", cancelWithParent);
    if (lastError)
      toast.error("Could not save subagent result", {
        description: String(lastError),
        action: {
          label: "Retry",
          onClick: () => {
            void taskCommand(lastRequest).catch((e) => toast.error(String(e)));
          },
        },
      });
  }
}
