import { beforeEach, describe, expect, it } from "vitest";
import {
  requestTerminalPrompt as request,
  useTerminalPromptStore,
} from "./terminalPrompts";

let owner: AbortController;
beforeEach(() => {
  owner = new AbortController();
});
const requestTerminalPrompt = (prompt: Parameters<typeof request>[0]) =>
  request(prompt, owner.signal);

describe("terminal prompts", () => {
  beforeEach(() => useTerminalPromptStore.setState({ queue: [] }));

  const answerHead = (answer: "allow" | "deny") => {
    const { queue, answer: respond } = useTerminalPromptStore.getState();
    respond(queue[0].id, answer);
  };

  it("queues prompts and resolves each with the user's answer", async () => {
    const paste = requestTerminalPrompt({ kind: "paste", text: "ls\n" });
    const read = requestTerminalPrompt({ kind: "clipboard-read" });
    expect(
      useTerminalPromptStore.getState().queue.map((p) => p.request.kind),
    ).toEqual(["paste", "clipboard-read"]);
    answerHead("deny");
    answerHead("allow");
    await expect(paste).resolves.toBe("deny");
    await expect(read).resolves.toBe("allow");
    expect(useTerminalPromptStore.getState().queue).toEqual([]);
  });

  it("shares one pending clipboard-read answer between repeated requests", async () => {
    const first = requestTerminalPrompt({ kind: "clipboard-read" });
    const second = requestTerminalPrompt({ kind: "clipboard-read" });
    expect(useTerminalPromptStore.getState().queue).toHaveLength(1);
    answerHead("allow");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "allow",
      "allow",
    ]);
  });

  it("denies requests beyond the pending bound instead of stacking dialogs", async () => {
    for (let index = 0; index < 8; index += 1) {
      void requestTerminalPrompt({ kind: "paste", text: `${index}\n` });
    }
    await expect(
      requestTerminalPrompt({ kind: "paste", text: "x\n" }),
    ).resolves.toBe("deny");
    expect(useTerminalPromptStore.getState().queue).toHaveLength(8);
  });
});

it("does not approve another program through the first program's clipboard prompt", async () => {
  useTerminalPromptStore.setState({ queue: [] });
  const first = requestTerminalPrompt({
    kind: "clipboard-read",
    program: "first program",
  });
  const second = requestTerminalPrompt({
    kind: "clipboard-read",
    program: "other program",
  });
  let secondAnswer: string | undefined;
  void second.then((answer) => {
    secondAnswer = answer;
  });
  const store = useTerminalPromptStore.getState();
  store.answer(store.queue[0].id, "allow");
  await first;
  await Promise.resolve();
  const answer = secondAnswer;
  for (const prompt of useTerminalPromptStore.getState().queue)
    useTerminalPromptStore.getState().answer(prompt.id, "deny");
  await second;
  expect(answer).toBeUndefined();
});

it("answers a burst of repeated reads without recursive resolver overflow", async () => {
  useTerminalPromptStore.setState({ queue: [] });
  const reads = Array.from({ length: 20_000 }, () =>
    requestTerminalPrompt({ kind: "clipboard-read" }),
  );
  const store = useTerminalPromptStore.getState();
  try {
    expect(() => store.answer(store.queue[0].id, "deny")).not.toThrow();
  } finally {
    useTerminalPromptStore.setState({ queue: [] });
  }
  const answers = await Promise.all(reads);
  expect(answers.every((answer) => answer === "deny")).toBe(true);
});

it("keeps identical programs in different terminals separate and removes cancelled prompts", async () => {
  useTerminalPromptStore.setState({ queue: [] });
  const other = new AbortController();
  const first = request(
    { kind: "clipboard-read", program: "vim" },
    owner.signal,
  );
  const second = request(
    { kind: "clipboard-read", program: "vim" },
    other.signal,
  );
  expect(useTerminalPromptStore.getState().queue).toHaveLength(2);
  owner.abort();
  await expect(first).resolves.toBe("deny");
  expect(useTerminalPromptStore.getState().queue).toHaveLength(1);
  const store = useTerminalPromptStore.getState();
  store.answer(store.queue[0].id, "allow");
  await expect(second).resolves.toBe("allow");
  await expect(
    request({ kind: "paste", text: "secret" }, owner.signal),
  ).resolves.toBe("deny");
});

it("does not merge different selections or protocols", () => {
  useTerminalPromptStore.setState({ queue: [] });
  void request({ kind: "clipboard-read" }, owner.signal, "osc52:c");
  void request({ kind: "clipboard-read" }, owner.signal, "osc52:p");
  void request({ kind: "clipboard-read" }, owner.signal, "kitty");
  expect(useTerminalPromptStore.getState().queue).toHaveLength(3);
  owner.abort();
  expect(useTerminalPromptStore.getState().queue).toHaveLength(0);
});
