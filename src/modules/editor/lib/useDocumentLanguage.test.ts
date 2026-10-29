import { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  resolve: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useLayoutEffect: (fn: () => undefined | (() => void)) => {
    const cleanup = fn();
    if (cleanup) fake.cleanups.push(cleanup);
  },
  useEffect: (fn: () => undefined | (() => void)) => {
    const cleanup = fn();
    if (cleanup) fake.cleanups.push(cleanup);
  },
}));
vi.mock("./languageResolver", () => ({ resolveLanguage: fake.resolve }));
import { useDocumentLanguage } from "./useDocumentLanguage";
const changed = vi.fn(),
  failed = vi.fn(),
  compartment = new Compartment();
const view = { dispatch: vi.fn() } as unknown as EditorView;
function render(
  source: string,
  target: EditorView | null = view,
  ready = true,
) {
  for (const cleanup of fake.cleanups.splice(0)) cleanup();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled hook driver
  useDocumentLanguage(target, source, ready, compartment, changed, failed);
}
beforeEach(() => {
  render("", null);
  vi.clearAllMocks();
});
it("does not resolve before an editor exists", () => {
  render("file.xml", null);
  expect(fake.resolve).not.toHaveBeenCalled();
});
it.each(["language", "close", "disable"])(
  "discards a pending parser on %s",
  async (kind) => {
    let done: (value: unknown) => void = () => {};
    fake.resolve
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            done = r;
          }),
      )
      .mockResolvedValue(null);
    render("file.xml");
    render("file.py", kind === "close" ? null : view, kind !== "disable");
    await Promise.resolve();
    await Promise.resolve();
    vi.mocked(view.dispatch).mockClear();
    done({ ext: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  },
);
it("reports current parser failures", async () => {
  fake.resolve.mockRejectedValue(Error("load failed"));
  render("file.xml");
  await Promise.resolve();
  await Promise.resolve();
  expect(failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: "load failed" }),
  );
});
