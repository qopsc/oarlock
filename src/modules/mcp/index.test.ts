import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  servers: [] as { enabled: boolean }[],
  runtimeLoaded: false,
  tools: {} as Record<string, unknown>,
  fail: false,
  starts: 0,
}));

vi.mock("./lib/configStore", () => ({
  loadWindowServers: async () => state.servers,
}));
vi.mock("./runtime", () => {
  state.runtimeLoaded = true;
  return {
    toolsForRun: async () => {
      state.starts++;
      if (state.fail) throw new Error("boom");
      return { tools: state.tools, access: {}, instructions: [] };
    },
  };
});

import { mcpToolsForRun } from "./index";

beforeEach(() => {
  state.tools = {};
  state.fail = false;
  state.starts = 0;
});

describe("mcpToolsForRun", () => {
  it("loads nothing of the MCP client while no server is enabled", async () => {
    state.servers = [{ enabled: false }];
    expect(await mcpToolsForRun()).toBe(null);
    expect(state.runtimeLoaded).toBe(false);
  });

  it("loads the client once a server is enabled and returns its tools", async () => {
    state.servers = [{ enabled: true }];
    state.tools = { mcp__a__b: {} };
    expect(await mcpToolsForRun()).toMatchObject({
      tools: { mcp__a__b: {} },
      access: {},
      instructions: [],
    });
    expect(state.runtimeLoaded).toBe(true);
  });

  it("gives a run no MCP tools rather than failing it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.servers = [{ enabled: true }];
    state.fail = true;
    expect(await mcpToolsForRun()).toBe(null);
    state.fail = false;
    expect(await mcpToolsForRun()).toBe(null);
  });
});

it("does not start servers until chat admission succeeds", async () => {
  state.servers = [{ enabled: true }];
  let admit!: () => void;
  const admission = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const waiting = mcpToolsForRun({ admission });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.starts).toBe(0);
  admit();
  await waiting;
  expect(state.starts).toBe(1);
});
it("does not start servers for a turn rejected by Stop", async () => {
  state.servers = [{ enabled: true }];
  const admission = Promise.reject(new Error("chat stopping"));
  void admission.catch(() => {});
  expect(await mcpToolsForRun({ admission })).toBeNull();
  expect(state.starts).toBe(0);
});
it("does not start servers for an already aborted turn", async () => {
  state.servers = [{ enabled: true }];
  const controller = new AbortController();
  controller.abort();
  expect(await mcpToolsForRun({ signal: controller.signal })).toBeNull();
  expect(state.starts).toBe(0);
});
