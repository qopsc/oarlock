/** One visible preview's port check. Cancellation also invalidates late replies. */
export class PortProbe {
  private active: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  cancel() {
    const active = this.active;
    this.active = null;
    if (!active) return;
    clearTimeout(active.timer);
    active.controller.abort();
  }

  start() {
    this.cancel();
    const controller = new AbortController();
    const active = {
      controller,
      timer: setTimeout(() => controller.abort(), 900),
    };
    this.active = active;
    return {
      signal: controller.signal,
      current: () => this.active === active,
      finish: () => {
        if (this.active === active) this.cancel();
      },
    };
  }
}

export async function probeUrl(
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal,
    });
    // Only reachability is needed; don't retain or download the page body.
    void response.body?.cancel().catch(() => {});
    return !signal.aborted;
  } catch {
    return false;
  }
}
