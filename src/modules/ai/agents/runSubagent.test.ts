import { beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({
  created: [] as { name: string; baseURL: string; apiKey?: string }[],
  models: [] as string[],
  waitForAbort: false,
  started: false,
  tools: [] as string[],
  /** Steps that call a tool first, each with its usage: input, cached, output. */
  toolSteps: [] as [number, number, number][],
  toolName: "glob",
  toolInput: { pattern: "**/*.ts" } as Record<string, unknown>,
  prompts: [] as string[],
}));
vi.mock("@ai-sdk/openai-compatible", async () => {
  const { MockLanguageModelV4: Mock } = await import("ai/test");
  return {
    createOpenAICompatible:
      (config: { name: string; baseURL: string; apiKey?: string }) =>
      (modelId: string) => {
        providers.created.push(config);
        providers.models.push(modelId);
        return new Mock({
          doGenerate: async (options: {
            tools?: { name: string }[];
            abortSignal?: AbortSignal;
            prompt?: unknown;
          }) => {
            if (providers.waitForAbort) {
              providers.started = true;
              await new Promise((_, reject) => {
                const abort = () => reject(options.abortSignal?.reason);
                if (options.abortSignal?.aborted) abort();
                else
                  options.abortSignal?.addEventListener("abort", abort, {
                    once: true,
                  });
              });
            }
            providers.prompts.push(JSON.stringify(options.prompt));
            providers.tools.push(...(options.tools ?? []).map((t) => t.name));
            const toolStep = providers.toolSteps.shift();
            if (toolStep) {
              const [input, cached, output] = toolStep;
              return {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: `call-${providers.toolSteps.length}`,
                    toolName: providers.toolName,
                    input: JSON.stringify(providers.toolInput),
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: {
                    total: input,
                    noCache: input - cached,
                    cacheRead: cached,
                    cacheWrite: 0,
                  },
                  outputTokens: { total: output, text: output, reasoning: 0 },
                },
                warnings: [],
              };
            }
            return {
              content: [{ type: "text", text: "found it" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              warnings: [],
            };
          },
        });
      },
  };
});
vi.mock("../lib/native", () => ({
  native: {
    canonicalize: async (path: string) => path,
    readFile: async () => ({
      kind: "text",
      content: "actual file contents",
      size: "actual file contents".length,
    }),
  },
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { runSubagent } from "./runSubagent";
import { writtenEntry } from "../tools/readCache";

const toolContext = {
  getCwd: () => "/workspace",
  getWorkspaceRoot: () => "/workspace",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  openPreview: () => false,
  spawnAgent: () => null,
  readAgentOutput: () => null,
  readCache: new Map(),
  getSessionId: () => "session",
} satisfies ToolContext;

beforeEach(() => {
  providers.waitForAbort = false;
  providers.started = false;
  providers.created.length = 0;
  providers.models.length = 0;
  providers.tools.length = 0;
  providers.toolSteps.length = 0;
  providers.toolName = "glob";
  providers.toolInput = { pattern: "**/*.ts" };
  providers.prompts.length = 0;
  toolContext.readCache.clear();
});

describe("runSubagent", () => {
  it("runs on the chat's custom endpoint", async () => {
    const result = await runSubagent({
      type: "explore",
      prompt: "find the config loader",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "compat-sub00001",
      config: {
        customEndpoints: [
          {
            id: "sub00001",
            name: "Box",
            baseURL: "https://llm.sub.example/v1",
            modelId: "qwen3-coder",
            contextLimit: 128_000,
          },
        ],
        customEndpointKeys: {
          sub00001: { origin: "https://llm.sub.example", key: "sk-sub" },
        },
      },
      toolContext,
    });
    expect(result.summary).toBe("found it");
    expect(providers.created).toEqual([
      expect.objectContaining({
        name: "openai-compatible",
        baseURL: "https://llm.sub.example/v1",
        apiKey: "sk-sub",
      }),
    ]);
    expect(providers.models).toEqual(["qwen3-coder"]);
  });

  it("gets only its read-only built-in tools, never the window's MCP tools", async () => {
    const { useMcpCatalog } = await import("@/modules/mcp/lib/catalog");
    useMcpCatalog.getState().setTools({
      mcp__srv__write: {
        name: "mcp__srv__write",
        serverId: "s",
        serverName: "srv",
        tool: "write",
        trusted: true,
      },
    });
    await runSubagent({
      type: "general",
      prompt: "look around",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: { ollamaModelId: "qwen3:8b" },
      toolContext,
    });
    useMcpCatalog.getState().setTools({});
    expect(providers.tools.length).toBeGreaterThan(0);
    expect(providers.tools.filter((name) => name.startsWith("mcp__"))).toEqual(
      [],
    );
    expect(
      providers.tools.every((name) =>
        ["read_file", "list_directory", "grep", "glob"].includes(name),
      ),
    ).toBe(true);
  });

  it("reports every step's usage with the model id it ran on", async () => {
    providers.toolSteps.push([120, 100, 30]);
    const onUsage = vi.fn();
    const result = await runSubagent({
      type: "explore",
      prompt: "find the config loader",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: { ollamaModelId: "qwen3:8b" },
      toolContext,
      onUsage,
    });
    expect(result.stepCount).toBe(2);
    // Priced by Oarlock's id for the model, not the server's name for it.
    expect(onUsage.mock.calls).toEqual([
      [
        "ollama-local",
        { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
      ],
      [
        "ollama-local",
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      ],
    ]);
  });

  it("sends a local server its configured model, not the placeholder id", async () => {
    await runSubagent({
      type: "explore",
      prompt: "find the config loader",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: {
        ollamaBaseURL: "http://127.0.0.1:11435/v1",
        ollamaModelId: "qwen3:8b",
      },
      toolContext,
    });
    expect(providers.created).toEqual([
      expect.objectContaining({
        name: "ollama",
        baseURL: "http://127.0.0.1:11435/v1",
      }),
    ]);
    expect(providers.models).toEqual(["qwen3:8b"]);
  });
});

it("aborts an in-flight subagent provider request with its parent", async () => {
  providers.waitForAbort = true;
  const controller = new AbortController();
  const pending = runSubagent({
    type: "explore",
    prompt: "look",
    keys: EMPTY_PROVIDER_KEYS,
    modelId: "compat-abort001",
    config: {
      customEndpointKeys: { abort001: null },
      customEndpoints: [
        {
          id: "abort001",
          name: "Test",
          baseURL: "https://example.invalid/v1",
          modelId: "test",
          contextLimit: 128000,
        },
      ],
    },
    toolContext,
    abortSignal: controller.signal,
  });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(providers.started).toBe(true));
  controller.abort();
  await rejected;
});

it("gives each subagent its own read history without altering the parent cache", async () => {
  const file = "/workspace/file.txt";
  const parentEntry = writtenEntry("actual file contents");
  toolContext.readCache.set(file, parentEntry);
  for (let index = 0; index < 2; index++) {
    providers.toolName = "read_file";
    providers.toolInput = { path: file };
    providers.toolSteps.push([1, 0, 1]);
    providers.prompts.length = 0;
    await runSubagent({
      type: "explore",
      prompt: "read the file",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "ollama-local",
      config: { ollamaModelId: "qwen3:8b" },
      toolContext,
    });
    expect(providers.prompts[1]).toContain("actual file contents");
    expect(toolContext.readCache.get(file)).toBe(parentEntry);
  }
});

it.each(["loading", "failed"] as const)(
  "does not send a subagent request with %s endpoint credentials",
  async (status) => {
    await expect(
      runSubagent({
        type: "explore",
        prompt: "private project context",
        keys: EMPTY_PROVIDER_KEYS,
        modelId: "compat-blocked",
        config: {
          customEndpoints: [
            {
              id: "blocked",
              name: "Blocked",
              baseURL: "https://blocked.test/v1",
              modelId: "model",
              contextLimit: 10000,
            },
          ],
          customEndpointKeys: { blocked: { status } },
        },
        toolContext,
      }),
    ).rejects.toThrow(/loading|Could not read/);
    expect(providers.created).toEqual([]);
    expect(providers.prompts).toEqual([]);
  },
);
it("rechecks admission after asynchronous model loading", async () => {
  let checks = 0;
  await expect(
    runSubagent({
      type: "explore",
      prompt: "private input",
      keys: EMPTY_PROVIDER_KEYS,
      modelId: "lmstudio-local",
      config: { lmstudioModelId: "local-model" },
      toolContext,
      assertReady: () => {
        if (++checks === 2) throw new Error("Preferences unavailable");
      },
    }),
  ).rejects.toThrow("Preferences");
  expect(providers.prompts).toEqual([]);
});
