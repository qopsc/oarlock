import { useCallback, useEffect, useRef, useState } from "react";

type Params<R> = {
  enabled: boolean;
  term: string;
  minLength: number;
  debounceMs: number;
  run: (term: string, signal: AbortSignal) => Promise<R>;
  scopeKey?: string;
  /** The result while disabled, searching or after a failure; keep it stable. */
  empty: R;
  /** Keep showing the last results while the next query runs. */
  keepPrevious?: boolean;
};

export type AsyncQueryState<R> = {
  results: R;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

export function useAsyncQuery<R>({
  enabled,
  term,
  minLength,
  debounceMs,
  run,
  empty,
  keepPrevious = false,
  scopeKey = "",
}: Params<R>): AsyncQueryState<R> {
  const [results, setResults] = useState<{ value: R; scope: string }>({
    value: empty,
    scope: scopeKey,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const emptyRef = useRef(empty);
  emptyRef.current = empty;

  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const execute = useCallback(
    (q: string, runner: (term: string, signal: AbortSignal) => Promise<R>) => {
      cancel();
      const requestId = requestIdRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const hits = await runner(q, controller.signal);
          if (requestId !== requestIdRef.current) return;
          setResults({ value: hits, scope: scopeKey });
        } catch (e) {
          if (requestId !== requestIdRef.current) return;
          setResults({ value: emptyRef.current, scope: scopeKey });
          setError(String(e));
        } finally {
          if (requestId === requestIdRef.current) setLoading(false);
        }
      })();
    },
    [cancel, scopeKey],
  );

  useEffect(() => {
    cancel();
    if (!enabled || term.length < minLength) {
      setResults({ value: emptyRef.current, scope: scopeKey });
      setLoading(false);
      setError(null);
      return cancel;
    }
    if (!keepPrevious) setResults({ value: emptyRef.current, scope: scopeKey });
    setLoading(true);
    setError(null);
    // A new `run` (another folder to search) runs the query again.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      execute(term, run);
    }, debounceMs);
    return cancel;
  }, [
    enabled,
    term,
    minLength,
    debounceMs,
    execute,
    keepPrevious,
    run,
    cancel,
    scopeKey,
  ]);

  const retry = useCallback(() => {
    if (enabled && term.length >= minLength) execute(term, run);
  }, [enabled, term, minLength, execute, run]);

  return {
    results: results.scope === scopeKey ? results.value : empty,
    loading,
    error,
    retry,
  };
}
