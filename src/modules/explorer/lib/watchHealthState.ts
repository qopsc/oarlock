export type WatchHealth = { revision: number; error: string | null };
export type WatchHealthIo = {
  listen: (changed: (health: WatchHealth) => void) => Promise<() => void>;
  read: () => Promise<WatchHealth>;
  retry: () => Promise<WatchHealth>;
  present: (error: string | null, retry: () => void) => void;
};

/** One listener per window, only while watches have consumers. */
export function createWatchHealthMonitor(io: WatchHealthIo) {
  const subscribers = new Set<{
    changed: (state: WatchHealth) => void;
    retry: () => void;
  }>();
  let snapshot: WatchHealth = { revision: -1, error: null };
  let unlisten: (() => void) | undefined;
  let starting: Promise<void> | undefined;
  let generation = 0;
  let retrying: Promise<void> | undefined;
  let readFailed = false;
  const accept = (state: WatchHealth) => {
    if (state.revision < snapshot.revision) return;
    if (
      !readFailed &&
      state.revision === snapshot.revision &&
      state.error === snapshot.error
    )
      return;
    readFailed = false;
    snapshot = state;
    io.present(state.error, () => void retry());
    for (const subscriber of subscribers) subscriber.changed(state);
  };
  const failed = (error: unknown) => {
    readFailed = true;
    snapshot = {
      ...snapshot,
      error: `Live updates could not be synchronized: ${String(error)}`,
    };
    io.present(snapshot.error, () => void retry());
    for (const subscriber of subscribers) subscriber.changed(snapshot);
  };
  const refresh = async () => {
    const own = generation;
    try {
      const state = await io.read();
      if (own === generation) accept(state);
    } catch (error) {
      if (own === generation) failed(error);
      throw error;
    }
  };
  const start = () => {
    if (starting) return starting;
    const own = generation;
    const promise = (async () => {
      try {
        if (!unlisten) {
          const off = await io.listen((state) => {
            if (own === generation) accept(state);
          });
          if (own !== generation) {
            off();
            return;
          }
          unlisten = off;
        }
        await refresh();
      } catch (error) {
        if (own === generation) {
          starting = undefined;
          failed(error);
        }
        throw error;
      }
    })();
    starting = promise;
    void promise.catch(() => {
      if (starting === promise) starting = undefined;
    });
    return promise;
  };
  const retry = (): Promise<void> => {
    if (!subscribers.size)
      return io.retry().then(
        () => {},
        () => {},
      );
    if (retrying) return retrying;
    const own = generation;
    const promise = (async () => {
      try {
        await start();
        if (own !== generation) return;
        const state = await io.retry();
        if (own !== generation) return;
        accept(state);
        for (const subscriber of subscribers) subscriber.retry();
      } catch (error) {
        if (own === generation) failed(error);
      } finally {
        if (own === generation) retrying = undefined;
      }
    })();
    retrying = promise;
    return promise;
  };
  return {
    retry,
    subscribe(
      changed: (health: WatchHealth) => void = () => {},
      onRetry: () => void = () => {},
    ) {
      const subscriber = { changed, retry: onRetry };
      subscribers.add(subscriber);
      let disposed = false;
      return {
        get ready() {
          return start();
        },
        current: () => snapshot,
        refresh,
        dispose() {
          if (disposed) return;
          disposed = true;
          subscribers.delete(subscriber);
          if (subscribers.size) return;
          generation++;
          unlisten?.();
          unlisten = undefined;
          starting = undefined;
          retrying = undefined;
          snapshot = { revision: -1, error: null };
          readFailed = false;
          io.present(null, () => {});
        },
      };
    },
  };
}
