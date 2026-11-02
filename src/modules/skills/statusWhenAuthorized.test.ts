import { expect, it, vi } from "vitest";

const watchers: { path: string; run: () => void }[] = [];

const calls: string[] = [];
let release!: () => void;

vi.mock("@/modules/workspace", () => ({
  authorizationSettled: () =>
    new Promise<void>((resolve) => {
      calls.push("authorizing");
      release = () => {
        calls.push("authorized");
        resolve();
      };
    }),
}));
vi.mock("@/modules/workspace/authorize", () => ({
  onAuthorized: (path: string, _env: unknown, run: () => void) => {
    const watcher = { path, run };
    watchers.push(watcher);
    return () => void watchers.splice(watchers.indexOf(watcher), 1);
  },
}));
vi.mock("./api", () => ({
  projectTrustStatus: async () => {
    calls.push("status");
    return null;
  },
}));

import {
  rerunWhenAuthorized,
  statusWhenAuthorized,
} from "./statusWhenAuthorized";

it("asks the backend only after the root's authorization has settled", async () => {
  const pending = statusWhenAuthorized("/work/proj", { kind: "local" });
  await Promise.resolve();
  expect(calls).toEqual(["authorizing"]);
  release();
  await pending;
  expect(calls).toEqual(["authorizing", "authorized", "status"]);
});

it("asks again when the root is authorized after the first ask, and stops when unsubscribed", () => {
  const rerun = vi.fn();
  const stop = rerunWhenAuthorized("/work/proj", { kind: "local" }, rerun);
  watchers.find((w) => w.path === "/work/proj")?.run();
  expect(rerun).toHaveBeenCalledTimes(1);
  stop();
  expect(watchers).toHaveLength(0);
});
