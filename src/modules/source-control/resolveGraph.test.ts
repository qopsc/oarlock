import { expect, it, vi } from "vitest";
import { openResolvedGraph } from "./resolveGraph";

it("does not open an old repository after context changes or a newer request", async () => {
  const finish: ((value: string) => void)[] = [];
  const resolve = () => new Promise<string>((done) => { finish.push(done); });
  const open = vi.fn();
  let generation = 1;
  const first = openResolvedGraph(resolve, () => generation === 1, open);
  generation = 2;
  const second = openResolvedGraph(resolve, () => generation === 2, open);
  finish[1]("new repo");
  await second;
  finish[0]("old repo");
  await first;
  expect(open).toHaveBeenCalledExactlyOnceWith("new repo");
});

it("ignores completion after its space closes", async () => {
  let finish!: (value: string) => void;
  let alive = true;
  const open = vi.fn();
  const pending = openResolvedGraph(() => new Promise<string>((done) => { finish = done; }), () => alive, open);
  alive = false;
  finish("old repo");
  await pending;
  expect(open).not.toHaveBeenCalled();
});
