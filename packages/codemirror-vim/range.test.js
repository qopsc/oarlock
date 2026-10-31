import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';
import { CodeMirror, Vim } from './index.js';

it.each([
    ['1sort', 'c\nb\na'],
    ['1,1sort', 'c\nb\na'],
    ['2,3sort', 'c\na\nb'],
    ['%sort', 'a\nb\nc'],
])('respects the explicit range in :%s', async (command, expected) => {
    const view = {
        state: EditorState.create({ doc: 'c\nb\na' }),
        dispatch(...specs) { this.state = this.state.update(...specs).state; },
        focus() {},
    };
    const cm = new CodeMirror(view);
    cm.operation = fn => fn();
    cm.onBeforeEndOperation = () => {};
    Vim.maybeInitVimState_(cm);
    await Vim.handleEx(cm, command);
    expect(cm.getValue()).toBe(expected);
});

it('limits :1global to the first line', async () => {
    const view = { state: EditorState.create({ doc: 'c\nb\na' }) };
    const cm = new CodeMirror(view);
    cm.operation = fn => fn();
    cm.vimRegexLines = (query, lines) => lines.map(line => query.exec(line));
    Vim.maybeInitVimState_(cm);
    const lines = [];
    Vim.defineEx('recordrange', 'recordrange', (_cm, params) => lines.push(params.line));
    await Vim.handleEx(cm, '1g/./recordrange');
    expect(lines).toEqual([0]);
});
