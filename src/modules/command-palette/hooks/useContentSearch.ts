import {
  currentWorkspaceEnv,
  useWorkspaceEnvStore,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { requestContentSearch } from "./requestContentSearch";
import { useCallback } from "react";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export const CONTENT_SEARCH_MIN_QUERY = 2;
const PALETTE_LIMIT = 80;
const DEBOUNCE_MS = 140;

export type ContentHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

/**
 * Who searches: each caller's new query cancels only its own previous walk
 * in the backend, so the palette and the sidebar never cut each other short.
 */
export type ContentSearchChannel = "palette" | "sidebar";

export type ContentSearchOwner = {
  env: WorkspaceEnv;
  spaceId: string | null;
  root: string;
};
export function contentSearchOwnerCurrent(owner: ContentSearchOwner): boolean {
  return (
    useSpaces.getState().activeId === owner.spaceId &&
    workspaceScopeKey(currentWorkspaceEnv()) === workspaceScopeKey(owner.env)
  );
}

type ContentSearchResults = {
  owner: ContentSearchOwner | null;
  hits: ContentHit[];
  /** The backend stopped at the result limit. */
  truncated: boolean;
  /** The query and folder these results are for. */
  term: string;
  root: string | null;
};

const NO_RESULTS: ContentSearchResults = {
  owner: null,
  hits: [],
  truncated: false,
  term: "",
  root: null,
};

export type ContentSearchState = Omit<
  AsyncQueryState<ContentSearchResults>,
  "results"
> & {
  results: ContentHit[];
  truncated: boolean;
  /** The query `results` belong to, which lags `term` while a search runs. */
  resultsTerm: string;
  /** The folder `results` belong to, which lags `root` likewise. */
  resultsRoot: string | null;
  resultsOwner: ContentSearchOwner | null;
};

export function useContentSearch(
  root: string | null,
  term: string,
  enabled: boolean,
  options: {
    channel?: ContentSearchChannel;
    maxResults?: number;
    /** Keep the last results on screen while the next query runs. */
    keepPrevious?: boolean;
  } = {},
): ContentSearchState {
  const {
    channel = "palette",
    maxResults = PALETTE_LIMIT,
    keepPrevious = false,
  } = options;
  const env = useWorkspaceEnvStore((state) => state.env);
  const spaceId = useSpaces((state) => state.activeId);
  const scopeKey = JSON.stringify([spaceId, workspaceScopeKey(env), root]);
  const run = useCallback(
    async (q: string, signal: AbortSignal): Promise<ContentSearchResults> => {
      if (!root) return NO_RESULTS;
      const res = await requestContentSearch(
        {
          pattern: q,
          root,
          maxResults,
          workspace: env,
          channel,
        },
        signal,
      );
      if (res.cancelled) throw new Error("Search cancelled");
      return {
        hits: res.hits,
        truncated: res.truncated,
        term: q,
        root,
        owner: { env, spaceId, root },
      };
    },
    [root, maxResults, channel, env, spaceId],
  );

  const { results, ...state } = useAsyncQuery({
    enabled: enabled && !!root,
    term,
    minLength: CONTENT_SEARCH_MIN_QUERY,
    debounceMs: DEBOUNCE_MS,
    run,
    empty: NO_RESULTS,
    keepPrevious,
    scopeKey,
  });
  return {
    ...state,
    results: results.hits,
    truncated: results.truncated,
    resultsTerm: results.term,
    resultsRoot: results.root,
    resultsOwner: results.owner,
  };
}
