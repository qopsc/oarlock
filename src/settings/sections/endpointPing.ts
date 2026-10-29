import { useEffect, useMemo, useRef, useState } from "react";
import { requestEndpointProbe } from "./endpointProbe";

export type PingState = {
  status: "idle" | "testing" | "ok" | "fail";
  /** Why the server could not be reached (DNS, refused, TLS certificate). */
  error?: string;
};

/** The endpoint card's Test: any HTTP answer means the server is reachable. */
export async function pingEndpoint(
  baseUrl: string,
  signal = new AbortController().signal,
): Promise<PingState> {
  try {
    const status = await requestEndpointProbe(baseUrl, signal);
    return { status: status > 0 ? "ok" : "fail" };
  } catch (error) {
    return { status: "fail", error: String(error) };
  }
}

/** A result belongs to the exact URL draft and invocation that requested it. */
export function useEndpointPing(baseUrl: string, enabled = true) {
  const context = useMemo(() => ({ baseUrl, enabled }), [baseUrl, enabled]);
  const request = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    context: typeof context;
    state: PingState;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing URL identity retires its pending invocation, including an away-and-back edit.
  useEffect(
    () => () => {
      ++request.current;
      pending.current?.abort();
      pending.current = null;
    },
    [context],
  );
  const test = async () => {
    if (!context.enabled) return;
    const id = ++request.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setResult({ context, state: { status: "testing" } });
    const state = await pingEndpoint(context.baseUrl, controller.signal);
    if (id === request.current) {
      pending.current = null;
      setResult({ context, state });
    }
  };
  const testStatus: PingState =
    result?.context === context ? result.state : { status: "idle" };
  return { test, testStatus };
}
