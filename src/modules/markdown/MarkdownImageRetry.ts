/**
 * A webview image reports only that it failed, not why. The preview scheme answers 503 while
 * its queue is full, so a failed local image is asked for again a few times, further apart each
 * time, before the failure is kept.
 */
export const LOCAL_IMAGE_RETRY_MS = [400, 1200, 3000] as const;

export type LocalLoad = {
  url: string;
  attempt: number;
  phase: "loading" | "waiting" | "failed";
};

/** The load state for `url`: a new URL starts over. */
export function loadFor(load: LocalLoad | null, url: string): LocalLoad {
  return load?.url === url ? load : { url, attempt: 0, phase: "loading" };
}

export function afterError(load: LocalLoad): LocalLoad {
  return load.attempt < LOCAL_IMAGE_RETRY_MS.length
    ? { ...load, phase: "waiting" }
    : { ...load, phase: "failed" };
}

export function afterWait(load: LocalLoad): LocalLoad {
  return { ...load, attempt: load.attempt + 1, phase: "loading" };
}

export function retryDelay(load: LocalLoad): number {
  return LOCAL_IMAGE_RETRY_MS[Math.min(load.attempt, LOCAL_IMAGE_RETRY_MS.length - 1)];
}

/** The URL of this attempt; a repeat changes it so the webview does not reuse the failure. */
export function attemptSrc(load: LocalLoad): string {
  return load.attempt === 0
    ? load.url
    : `${load.url}${load.url.includes("?") ? "&" : "?"}r=${load.attempt}`;
}
