// Run this only under an external subprocess deadline: this is an unresolved
// main-thread backtracking reproduction, not a passing safety check.
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { MatchScan } from '../../src/modules/editor/lib/searchCount.ts';
const state = EditorState.create({doc: Array(32).fill('a'.repeat(34) + '!').join('\n')});
const query = new SearchQuery({search: '(a+)+$', regexp: true});
console.log('editor-regex-started');
if (process.argv[2] === 'cursor') query.getCursor(state).next();
else new MatchScan(state, query).step(() => true);
console.log('editor-regex-completed');
