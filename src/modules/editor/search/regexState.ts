import {
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import type { RegexSpec } from "./regexTypes";
export const setRegexQuery = StateEffect.define<RegexSpec | null>();
export const regexQuery = StateField.define<RegexSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRegexQuery)) value = effect.value;
      else if (effect.is(setSearchQuery)) value = null;
    }
    return value;
  },
});
export type EditorQuery = Pick<
  SearchQuery,
  "search" | "replace" | "regexp" | "caseSensitive" | "wholeWord" | "literal"
>;
export const getEditorQuery = (state: EditorState): EditorQuery =>
  state.field(regexQuery, false) ?? getSearchQuery(state);
export const sameQuery = (a: EditorQuery, b: EditorQuery) =>
  a.search === b.search &&
  a.replace === b.replace &&
  a.regexp === b.regexp &&
  a.caseSensitive === b.caseSensitive &&
  a.wholeWord === b.wholeWord &&
  a.literal === b.literal;
export function queryEffects(query: EditorQuery) {
  return query.regexp
    ? [
        setSearchQuery.of(new SearchQuery({ search: "" })),
        setRegexQuery.of({ ...query, regexp: true }),
      ]
    : [
        setSearchQuery.of(new SearchQuery({ ...query, regexp: false })),
        setRegexQuery.of(null),
      ];
}
/** Third-party query effects must never reach CodeMirror's synchronous regex highlighter. */
export const interceptRegex = EditorState.transactionFilter.of((tr) => {
  let query: SearchQuery | undefined;
  for (const effect of tr.effects)
    if (effect.is(setSearchQuery)) query = effect.value;
  return query?.regexp
    ? [tr, { effects: queryEffects(query), sequential: true }]
    : tr;
});
