/** One native read at a time; a superseded response never reaches the pane. */
export function createLiveDiff<T>(options: {
  read: () => Promise<T>;
  loading: () => void;
  loaded: (value: T) => void;
  failed: (error: unknown) => void;
}) {
  let generation = 0;
  let disposed = false;
  let ready = false;
  let blocked = false;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    timer = null;
    if (disposed || !ready || running) return;
    const own = generation;
    pending = false;
    running = true;
    try {
      const value = await options.read();
      if (!disposed && own === generation) options.loaded(value);
    } catch (error) {
      if (!disposed && own === generation) options.failed(error);
    } finally {
      running = false;
      if (!disposed && pending) schedule();
    }
  };
  const schedule = () => {
    if (!disposed && ready && !running && timer === null)
      timer = setTimeout(() => void run(), 40);
  };
  return {
    start() {
      if (disposed) return;
      ready = true;
      blocked = false;
      generation++;
      pending = true;
      options.loading();
      if (!running) void run();
    },
    invalidate() {
      if (disposed || blocked) return;
      generation++;
      pending = true;
      options.loading();
      schedule();
    },
    fail(error: unknown) {
      if (disposed) return;
      generation++;
      ready = false;
      blocked = true;
      pending = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      options.failed(error);
    },
    dispose() {
      disposed = true;
      generation++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
