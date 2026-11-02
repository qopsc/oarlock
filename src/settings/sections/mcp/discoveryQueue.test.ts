import { expect, it, vi } from "vitest";
import type { McpServerConfig } from "@/modules/mcp/lib/config";
import type { AuthStatus } from "@/modules/mcp/lib/auth";
import { DiscoveryQueue } from "./discoveryQueue";

const server = (id: number): McpServerConfig => ({
  id: String(id),
  name: String(id),
  source: "settings",
  enabled: true,
  trusted: false,
  tools: {},
  secretsRevision: 0,
  transport: { type: "http", url: "https://example.test", headers: [] },
});
const status = (id: string): AuthStatus => ({
  serverId: id,
  state: "none",
  reason: null,
  requiredScope: null,
  scope: null,
  issuer: null,
  expiresAtMs: null,
  canRefresh: false,
  signingIn: false,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("bounds active work, advances the queue and discards queued work on close", async () => {
  const jobs: { signal: AbortSignal; finish: () => void }[] = [];
  const run = vi.fn(
    (s: McpServerConfig, signal: AbortSignal) =>
      new Promise<AuthStatus>((resolve) =>
        jobs.push({ signal, finish: () => resolve(status(s.id)) }),
      ),
  );
  const queue = new DiscoveryQueue(run, vi.fn());
  const list = Array.from({ length: 17 }, (_, i) => server(i));
  queue.sync(
    list,
    list.map((s) => status(s.id)),
  );
  await flush();
  expect(run).toHaveBeenCalledTimes(8);
  jobs[0].finish();
  await flush();
  expect(run).toHaveBeenCalledTimes(9);
  queue.close();
  expect(jobs.slice(1).every((job) => job.signal.aborted)).toBe(true);
  jobs.forEach((job) => {
    job.finish();
  });
  await flush();
  expect(run).toHaveBeenCalledTimes(9);
});

it("cancelled work keeps its capacity until settling and cannot report into its replacement", async () => {
  const jobs: { signal: AbortSignal; finish: () => void }[] = [];
  const report = vi.fn();
  const run = vi.fn(
    (s: McpServerConfig, signal: AbortSignal) =>
      new Promise<AuthStatus>((resolve) =>
        jobs.push({ signal, finish: () => resolve(status(s.id)) }),
      ),
  );
  const queue = new DiscoveryQueue(run, report);
  const list = Array.from({ length: 8 }, (_, i) => server(i));
  queue.sync(
    list,
    list.map((s) => status(s.id)),
  );
  await flush();
  const changed = list.map((s) => ({ ...s, secretsRevision: 1 }));
  queue.reconcile(changed);
  queue.sync(
    changed,
    changed.map((s) => status(s.id)),
  );
  await flush();
  expect(run).toHaveBeenCalledTimes(8);
  expect(jobs.every((job) => job.signal.aborted)).toBe(true);
  jobs.slice().forEach((job) => {
    job.finish();
  });
  await flush();
  expect(run).toHaveBeenCalledTimes(16);
  expect(report).not.toHaveBeenCalled();
  queue.close();
  jobs.forEach((job) => {
    job.finish();
  });
});

it("requires explicit retry after failure and blocks discovery during an auth action", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error("busy"))
    .mockResolvedValue(status("0"));
  const report = vi.fn();
  const queue = new DiscoveryQueue(run, report);
  const list = [server(0)],
    states = [status("0")];
  queue.sync(list, states);
  await flush();
  expect(report.mock.calls[0][1]).toBeInstanceOf(Error);
  queue.sync(list, states);
  await flush();
  expect(run).toHaveBeenCalledTimes(1);
  queue.suspend(list[0]);
  queue.retry("0");
  queue.sync(list, states);
  await flush();
  expect(run).toHaveBeenCalledTimes(1);
  queue.resume("0");
  queue.sync(list, states);
  await flush();
  expect(run).toHaveBeenCalledTimes(2);
  queue.close();
});

it("caps retained discovery candidates and supports effect teardown/restart", async () => {
  const run = vi.fn(async (s: McpServerConfig) => status(s.id));
  const queue = new DiscoveryQueue(run, vi.fn());
  const list = Array.from({ length: 300 }, (_, i) => server(i));
  queue.sync(
    list,
    list.map((s) => status(s.id)),
  );
  await flush();
  expect(run).toHaveBeenCalledTimes(256);
  queue.close();
  queue.open();
  queue.sync([list[0]], [status("0")]);
  await flush();
  expect(run).toHaveBeenCalledTimes(257);
  queue.close();
});
