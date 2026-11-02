import { expect, it, vi } from "vitest";

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
vi.mock("./api", () => ({
  projectTrustStatus: async () => {
    calls.push("status");
    return null;
  },
}));

import { statusWhenAuthorized } from "./statusWhenAuthorized";

it("asks the backend only after the root's authorization has settled", async () => {
  const pending = statusWhenAuthorized("/work/proj", { kind: "local" });
  await Promise.resolve();
  expect(calls).toEqual(["authorizing"]);
  release();
  await pending;
  expect(calls).toEqual(["authorizing", "authorized", "status"]);
});
