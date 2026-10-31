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
export type ImageLease = { url: Promise<string>; release: () => void };

/** Each consumer releases exactly its acquisition, once. Pending work belongs
 * to live consumers; only completed unused images enter the bounded idle cache. */
export class RemoteImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly idle = new Map<string, Entry>();
  private idleBytes = 0;

  constructor(
    private readonly load: (url: string, signal: AbortSignal) => Promise<Blob>,
    private readonly create: (blob: Blob) => string,
    private readonly revoke: (objectUrl: string) => void,
    private readonly idleLimit = 32,
    private readonly idleByteLimit = 32 * 1024 * 1024,
  ) {}

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
            return this.load(url, controller.signal);
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
