import { describe, expect, it, vi } from "vitest";
import { decodeImagePayload, RemoteImageCache } from "./remoteImages";

it("decodes image payloads and refuses truncation", async () => {
  const type = new TextEncoder().encode("image/svg+xml");
  const bytes = new Uint8Array([type.length, ...type, 60, 115]);
  const blob = decodeImagePayload(bytes.buffer);
  expect(blob.type).toBe("image/svg+xml");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
    new Uint8Array([60, 115]),
  );
  expect(() => decodeImagePayload(new ArrayBuffer(0))).toThrow();
  expect(() => decodeImagePayload(new Uint8Array([9, 1]).buffer)).toThrow();
});

function setup(idleLimit = 2, idleBytes = 32 * 1024 * 1024) {
  const load = vi.fn(async (url: string) => new Blob([url]));
  let n = 0;
  const create = vi.fn(() => `blob:${++n}`);
  const revoke = vi.fn();
  return {
    load,
    create,
    revoke,
    cache: new RemoteImageCache(load, create, revoke, idleLimit, idleBytes),
  };
}

describe("RemoteImageCache", () => {
  it("shares downloads but releases each consumer exactly once", async () => {
    const { cache, load, revoke } = setup(0);
    const a = cache.acquire("https://x/a.png");
    const b = cache.acquire("https://x/a.png");
    expect(await a.url).toBe(await b.url);
    expect(load).toHaveBeenCalledOnce();
    a.release();
    a.release();
    expect(revoke).not.toHaveBeenCalled();
    b.release();
    b.release();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(await b.url);
  });

  it("keeps unused images for reuse and evicts the oldest unused entry", async () => {
    const { cache, load, revoke } = setup(1);
    const a = cache.acquire("a");
    await a.url;
    a.release();
    const reused = cache.acquire("a");
    expect(await reused.url).toBe(await a.url);
    reused.release();
    const b = cache.acquire("b");
    await b.url;
    b.release();
    expect(revoke).toHaveBeenCalledWith(await a.url);
    const again = cache.acquire("a");
    await again.url;
    again.release();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not let cleanup of a failed acquisition release a later successful one", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Blob(["image"]));
    const revoke = vi.fn();
    const cache = new RemoteImageCache(load, () => "blob:retry", revoke, 0);
    const old = cache.acquire("same");
    await expect(old.url).rejects.toThrow("offline");
    const retry = cache.acquire("same");
    await retry.url;
    old.release();
    expect(revoke).not.toHaveBeenCalled();
    retry.release();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:retry");
  });

  it("cancels only after the last pending consumer releases and ignores late bytes", async () => {
    let resolve!: (blob: Blob) => void;
    let signal!: AbortSignal;
    const load = vi.fn((_url: string, owned: AbortSignal) => {
      signal = owned;
      return new Promise<Blob>((done) => {
        resolve = done;
      });
    });
    const create = vi.fn(() => "blob:late");
    const cache = new RemoteImageCache(load, create, vi.fn());
    const a = cache.acquire("same");
    const b = cache.acquire("same");
    const settled = a.url.catch((error) => error);
    await Promise.resolve();
    a.release();
    expect(signal.aborted).toBe(false);
    b.release();
    expect(signal.aborted).toBe(true);
    const next = cache.acquire("same");
    const nextSettled = next.url.catch((error) => error);
    // Late success of the old request must not create a URL or remove its replacement.
    resolve(new Blob(["late"]));
    expect((await settled).name).toBe("AbortError");
    expect(create).not.toHaveBeenCalled();
    next.release();
    resolve(new Blob(["also late"]));
    await nextSettled;
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not start an acquisition released before its first task", async () => {
    const { cache, load } = setup();
    const lease = cache.acquire("unused");
    lease.release();
    await expect(lease.url).rejects.toMatchObject({ name: "AbortError" });
    expect(load).not.toHaveBeenCalled();
  });

  it("retries after object URL creation fails", async () => {
    const { cache, create } = setup();
    create.mockImplementationOnce(() => {
      throw new Error("allocation failed");
    });
    const old = cache.acquire("a");
    await expect(old.url).rejects.toThrow("allocation failed");
    const next = cache.acquire("a");
    await expect(next.url).resolves.toBe("blob:1");
    old.release();
    next.release();
  });

  it("bounds unused image retention by bytes as well as entry count", async () => {
    const retained = new Map<string, number>();
    let next = 0;
    const cache = new RemoteImageCache(
      async () => new Blob([new Uint8Array(12 * 1024 * 1024)]),
      (blob) => {
        const id = `blob:${++next}`;
        retained.set(id, blob.size);
        return id;
      },
      (url) => {
        retained.delete(url);
      },
    );
    for (let i = 0; i < 3; i++) {
      const lease = cache.acquire(`https://x/${i}`);
      await lease.url;
      lease.release();
    }
    expect([...retained.values()].reduce((sum, size) => sum + size, 0)).toBe(
      24 * 1024 * 1024,
    );
    expect(retained.has("blob:1")).toBe(false);
  });

  it("excludes active images from eviction and accounts for reuse without double counting", async () => {
    const { cache, revoke } = setup(32, 3);
    const active = cache.acquire("12345");
    await active.url;
    const a = cache.acquire("ab");
    await a.url;
    a.release();
    const reused = cache.acquire("ab");
    await reused.url;
    const b = cache.acquire("cd");
    await b.url;
    b.release();
    expect(revoke).not.toHaveBeenCalled();
    reused.release();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(await b.url);
    active.release();
    expect(revoke).toHaveBeenCalledWith(await active.url);
  });
});
