import { expect, it } from "vitest";
import { beginChatWork, drainChatWork } from "./chatWork";

it("waits for work admitted while an earlier startup is draining", async () => {
  const first = beginChatWork("drain");
  let done = false;
  const drained = drainChatWork("drain").then(() => {
    done = true;
  });
  const second = beginChatWork("drain");
  first();
  await Promise.resolve();
  expect(done).toBe(false);
  second();
  await drained;
});
it("duplicate startup completion cannot forget a later turn's work", async () => {
  const first = beginChatWork("repeat");
  first();
  const second = beginChatWork("repeat");
  first();
  let done = false;
  const drained = drainChatWork("repeat").then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  second();
  await drained;
});
it("does not wait for another chat or a running independent subagent", async () => {
  const other = beginChatWork("other");
  const started = beginChatWork("parent");
  started();
  await drainChatWork("parent");
  other();
});
