import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  validate: vi.fn(async () => {}),
  build: vi.fn(async () => "model"),
  generate: vi.fn(async () => ({ text: "completion" })),
}));
vi.mock("@/modules/ai/lib/agent", () => ({ buildLanguageModel: fake.build }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.validate }));
vi.mock("ai", () => ({ generateText: fake.generate }));
import { completionAccess, type CompletionCredential } from "./credential";
import { requestCompletion } from "./provider";
beforeEach(() => vi.clearAllMocks());
it("passes the selected origin-checked endpoint credential explicitly to the model builder", async () => {
  const request = {
    document: { workspace: { kind: "local" as const }, allowed: true },
    prefix: "const value = ",
    suffix: "",
    language: "typescript",
    filename: "a.ts",
    indentUnit: "  ",
  };
  for (const apiKey of ["bound-key", null]) {
    await requestCompletion(
      request,
      {
        provider: "openai-compatible",
        modelId: "native-model",
        apiKey,
        credentialStatus: apiKey ? "ready" : "keyless",
        lmstudioBaseURL: "",
        openaiCompatibleBaseURL: "https://native.example/v1",
      },
      new AbortController().signal,
    );
    expect(fake.build).toHaveBeenLastCalledWith(
      "openai-compatible",
      expect.any(Object),
      "native-model",
      expect.objectContaining({
        openaiCompatibleBaseURL: "https://native.example/v1",
      }),
      apiKey,
    );
  }
});

const content = {
  document: { workspace: { kind: "local" as const }, allowed: true },
  prefix: "private source",
  suffix: "",
  filename: "source.ts",
  language: "typescript",
  indentUnit: "  ",
};
it.each([
  null,
  { status: "loading", provider: "openai-compatible", modelId: "compat-a" },
  { status: "failed", provider: "openai-compatible", modelId: "compat-a" },
  {
    status: "ready",
    provider: "openai-compatible",
    modelId: "compat-a",
    key: null,
    endpoint: { origin: "https://old.example", key: "secret" },
  },
] satisfies (CompletionCredential | null)[])(
  "does not build or call a model when endpoint credentials are blocked: %j",
  async (credential) => {
    const baseURL = "https://new.example/v1";
    const access = completionAccess(
      credential,
      "openai-compatible",
      "compat-a",
      baseURL,
    );
    await expect(
      requestCompletion(
        content,
        {
          provider: "openai-compatible",
          modelId: "model",
          lmstudioBaseURL: "",
          openaiCompatibleBaseURL: baseURL,
          ...access,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("not ready");
    expect(fake.build).not.toHaveBeenCalled();
    expect(fake.generate).not.toHaveBeenCalled();
  },
);
it("does not send editor contents when cancelled during model loading", async () => {
  const controller = new AbortController();
  fake.build.mockImplementationOnce(async () => {
    controller.abort();
    return "model";
  });
  await expect(
    requestCompletion(
      content,
      {
        provider: "openai",
        modelId: "model",
        apiKey: "synthetic",
        credentialStatus: "ready",
        lmstudioBaseURL: "",
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fake.generate).not.toHaveBeenCalled();
});

it.each([undefined, { workspace: { kind: "local" as const }, allowed: false }])(
  "rejects buffers without native load eligibility: %j",
  async (document) => {
    await expect(
      requestCompletion(
        { ...content, document },
        {
          provider: "openai",
          modelId: "model",
          apiKey: "synthetic",
          credentialStatus: "ready",
          lmstudioBaseURL: "",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("document");
    expect(fake.generate).not.toHaveBeenCalled();
    expect(fake.build).not.toHaveBeenCalled();
  },
);

it("blocks a protected or inaccessible document before uploading the buffer", async () => {
  fake.validate.mockRejectedValueOnce(new Error("protected document"));
  await expect(
    requestCompletion(
      {
        ...content,
        filename: "/project/.env",
        prefix: "SYNTHETIC_SECRET",
        document: {
          workspace: { kind: "wsl", distro: "Ubuntu" },
          allowed: true,
        },
      },
      {
        provider: "openai",
        modelId: "model",
        apiKey: "synthetic",
        credentialStatus: "ready",
        lmstudioBaseURL: "",
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("protected document");
  expect(fake.validate).toHaveBeenCalledWith("ai_validate_document", {
    path: "/project/.env",
    workspace: { kind: "wsl", distro: "Ubuntu" },
  });
  expect(fake.generate).not.toHaveBeenCalled();
});

it("cancels during native document validation without sending content", async () => {
  const controller = new AbortController();
  fake.validate.mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(
    requestCompletion(
      content,
      {
        provider: "openai",
        modelId: "model",
        apiKey: "synthetic",
        credentialStatus: "ready",
        lmstudioBaseURL: "",
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fake.generate).not.toHaveBeenCalled();
});
