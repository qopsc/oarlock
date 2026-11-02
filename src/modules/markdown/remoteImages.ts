import { requestRemoteImage } from "./remoteImageRequest";

/** `[u8 type length][type][bytes]` from the native image result. */
export function decodeImagePayload(
  buffer: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Blob {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) throw new Error("empty image payload");
  const typeEnd = 1 + bytes[0];
  if (typeEnd > bytes.length) throw new Error("truncated image payload");
  const type = new TextDecoder().decode(bytes.subarray(1, typeEnd));
  return new Blob([bytes.subarray(typeEnd)], { type });
}

type Entry = {
  refs: number;
  promise: Promise<string>;
  controller: AbortController;
  objectUrl?: string;
  bytes: number;
};
/** How many images one window loads at once. The backend allows 16 per window, and a request
 * it has not yet seen cancelled still counts there, so the page stays under it. */
export const MAX_CONCURRENT_IMAGES = 12;

export type ImageLease = { url: Promise<string>; release: () => void };

/** Each consumer releases exactly its acquisition, once. Pending work belongs
 * to live consumers; only completed unused images enter the bounded idle cache. */
export class RemoteImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly idle = new Map<string, Entry>();
  private idleBytes = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly load: (url: string, signal: AbortSignal) => Promise<Blob>,
    private readonly create: (blob: Blob) => string,
    private readonly revoke: (objectUrl: string) => void,
    private readonly idleLimit = 32,
    private readonly idleByteLimit = 32 * 1024 * 1024,
    private readonly concurrency = MAX_CONCURRENT_IMAGES,
  ) {}

  /** A place among the images loading now; waits in order behind them. A lease released
   * while waiting leaves the queue without ever starting its load. */
  private take(signal: AbortSignal): Promise<() => void> | (() => void) {
    const release = () => {
      this.active--;
      this.waiting.shift()?.();
    };
    if (this.active < this.concurrency) {
      this.active++;
      return release;
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", leave);
        this.active++;
        resolve(release);
      };
      const leave = () => {
        const at = this.waiting.indexOf(start);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      };
      this.waiting.push(start);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  acquire(url: string): ImageLease {
    let entry = this.entries.get(url);
    if (entry) {
      this.removeIdle(url, entry);
    } else {
      const controller = new AbortController();
      const created: Entry = {
        refs: 0,
        bytes: 0,
        controller,
        promise: Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            const run = (done: () => void) => {
              try {
                controller.signal.throwIfAborted();
                return this.load(url, controller.signal).finally(done);
              } catch (error) {
                done();
                throw error;
              }
            };
            const place = this.take(controller.signal);
            return typeof place === "function" ? run(place) : place.then(run);
          })
          .then((blob) => {
            controller.signal.throwIfAborted();
            created.bytes = blob.size;
            created.objectUrl = this.create(blob);
            return created.objectUrl;
          })
          .catch((error) => {
            this.drop(url, created);
            throw error;
          }),
      };
      entry = created;
      this.entries.set(url, entry);
    }
    entry.refs++;
    const owned = entry;
    let released = false;
    return {
      url: owned.promise,
      release: () => {
        if (released) return;
        released = true;
        owned.refs--;
        if (owned.refs > 0 || this.entries.get(url) !== owned) return;
        if (owned.objectUrl === undefined) {
          this.entries.delete(url);
          owned.controller.abort();
          return;
        }
        this.idle.set(url, owned);
        this.idleBytes += owned.bytes;
        while (
          this.idle.size > this.idleLimit ||
          this.idleBytes > this.idleByteLimit
        ) {
          const first = this.idle.entries().next().value;
          if (!first) break;
          this.drop(...first);
        }
      },
    };
  }

  private removeIdle(url: string, entry: Entry): void {
    if (this.idle.get(url) !== entry) return;
    this.idle.delete(url);
    this.idleBytes -= entry.bytes;
  }

  private drop(url: string, entry: Entry): void {
    this.removeIdle(url, entry);
    if (this.entries.get(url) === entry) this.entries.delete(url);
    if (entry.objectUrl !== undefined) {
      this.revoke(entry.objectUrl);
      entry.objectUrl = undefined;
    }
  }
}

export const remoteImages = new RemoteImageCache(
  async (url, signal) =>
    decodeImagePayload(await requestRemoteImage(url, signal)),
  (blob) => URL.createObjectURL(blob),
  (objectUrl) => URL.revokeObjectURL(objectUrl),
);
