import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fake.listen }));
import {
  retryCustomEndpoints,
  createCustomEndpoint,
  deleteCustomEndpoint,
  updateCustomEndpoint,
  onCustomEndpoints,
} from "./endpoints";
const endpoint = {
  id: "a",
  name: "A",
  baseURL: "https://a.example",
  modelId: "model",
  contextLimit: 128000,
};
beforeEach(() => {
  fake.invoke.mockReset().mockResolvedValue({ revision: 0, endpoints: [] });
  fake.listen.mockReset().mockResolvedValue(vi.fn());
});
it("sends creates without page-selected IDs and updates/deletes without stale lists", async () => {
  await createCustomEndpoint(endpoint);
  expect(fake.invoke).toHaveBeenLastCalledWith("ai_endpoints_mutate", {
    change: {
      kind: "create",
      endpoint: {
        name: "A",
        baseURL: "https://a.example",
        modelId: "model",
        contextLimit: 128000,
      },
    },
  });
  await updateCustomEndpoint("a", { modelId: "new" });
  expect(fake.invoke).toHaveBeenLastCalledWith("ai_endpoints_mutate", {
    change: { kind: "update", id: "a", patch: { modelId: "new" } },
  });
  await deleteCustomEndpoint("a");
  expect(fake.invoke).toHaveBeenLastCalledWith("ai_endpoints_mutate", {
    change: { kind: "delete", id: "a" },
  });
});
it("registers before reading and ignores a delayed snapshot older than a deletion event", async () => {
  let resolve!: (v: unknown) => void;
  fake.invoke.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const seen = vi.fn(),
    failed = vi.fn();
  const subscribed = onCustomEndpoints(seen, failed);
  await Promise.resolve();
  const event = fake.listen.mock.calls[0][1];
  event({ payload: { revision: 2, endpoints: [] } });
  resolve({ revision: 1, endpoints: [endpoint] });
  const stop = await subscribed;
  event({ payload: { revision: 1, endpoints: [endpoint] } });
  expect(seen.mock.calls).toEqual([[[]]]);
  stop();
  event({ payload: { revision: 3, endpoints: [endpoint] } });
  expect(seen).toHaveBeenCalledOnce();
});
it("keeps a listener after a failed load so a repaired store can recover", async () => {
  fake.invoke.mockRejectedValue(new Error("damaged"));
  const seen = vi.fn(),
    failed = vi.fn();
  const stop = await onCustomEndpoints(seen, failed);
  expect(failed).toHaveBeenCalledOnce();
  fake.listen.mock.calls[0][1]({
    payload: { revision: 0, endpoints: [endpoint] },
  });
  expect(seen).toHaveBeenCalledWith([endpoint]);
  stop();
});

it("retries through the revision-checked event stream without applying a stale reply", async () => {
  const seen = vi.fn();
  const stop = await onCustomEndpoints(seen, vi.fn());
  const event = fake.listen.mock.calls[0][1];
  seen.mockClear();
  let resolve!: (v: unknown) => void;
  fake.invoke.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const retry = retryCustomEndpoints();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fake.invoke).toHaveBeenLastCalledWith("ai_endpoints_snapshot", {
    refresh: true,
  });
  event({ payload: { revision: 2, endpoints: [] } });
  event({ payload: { revision: 1, endpoints: [endpoint] } });
  resolve({ revision: 1, endpoints: [endpoint] });
  await retry;
  expect(seen.mock.calls).toEqual([[[]]]);
  stop();
});

it("Retry reconnects a failed listener before reading and keeps later edits live", async () => {
  fake.listen.mockRejectedValueOnce(new Error("event bridge unavailable"));
  const seen = vi.fn(),
    failed = vi.fn();
  const stop = await onCustomEndpoints(seen, failed).catch((error) => {
    failed(error);
    return () => {};
  });
  expect(failed).toHaveBeenCalledOnce();
  fake.invoke.mockResolvedValue({ revision: 1, endpoints: [endpoint] });
  await retryCustomEndpoints();
  expect(fake.listen).toHaveBeenCalledTimes(2);
  expect(seen).toHaveBeenLastCalledWith([endpoint]);
  fake.listen.mock.calls[1][1]({ payload: { revision: 2, endpoints: [] } });
  expect(seen).toHaveBeenLastCalledWith([]);
  stop();
});

it("concurrent Retry calls share registration and clean up a late listener on disposal", async () => {
  fake.listen.mockRejectedValueOnce(new Error("offline"));
  const seen = vi.fn();
  const stop = await onCustomEndpoints(seen, vi.fn());
  let finish!: (v: () => void) => void;
  fake.listen.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const one = retryCustomEndpoints();
  const two = retryCustomEndpoints();
  expect(fake.listen).toHaveBeenCalledTimes(2);
  stop();
  const unlisten = vi.fn();
  finish(unlisten);
  await Promise.all([one, two]);
  expect(unlisten).toHaveBeenCalledOnce();
  expect(seen).not.toHaveBeenCalled();
  await retryCustomEndpoints();
  expect(fake.listen).toHaveBeenCalledTimes(2);
});
