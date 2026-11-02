// Historical pinned-upstream reproduction. Run under an external deadline.
import { EditorState } from '@codemirror/state';
import { CodeMirror } from '../../packages/codemirror-vim/upstream/index.js';
const state = EditorState.create({doc: Array(32).fill('a'.repeat(34) + '!').join('\n')});
console.log('vim-regex-started');
CodeMirror.prototype.getSearchCursor.call({cm6: {state}}, /(a+)+$/, {line: 0, ch: 0}).findNext();
console.log('vim-regex-completed');
