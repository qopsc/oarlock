import { EditorState } from '@codemirror/state';
import { expect, it, vi } from 'vitest';
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

it('applies each option in a single :set command', async () => {
    const view = { state: EditorState.create({ doc: '' }) };
    const cm = new CodeMirror(view);
    cm.operation = fn => fn();
    cm.onBeforeEndOperation = () => {};
    Vim.maybeInitVimState_(cm);
    await Vim.handleEx(cm, 'set textwidth=42 filetype=python');
    expect(cm.getOption('textwidth')).toBe(42);
    expect(cm.getOption('mode')).toBe('python');
    await Vim.handleEx(cm, 'set filetype& textwidth=60');
    expect(cm.getOption('mode')).toBe('auto');
    expect(cm.getOption('textwidth')).toBe(60);
    await Vim.handleEx(cm, 'setlocal textwidth=72 filetype=rust');
    expect(cm.getOption('textwidth')).toBe(72);
    expect(cm.getOption('mode')).toBe('rust');
    try {
        await Vim.handleEx(cm, 'setglobal nopcre insertModeEscKeysTimeout=456');
        expect(Vim.getOption('pcre', cm, { scope: 'global' })).toBe(false);
        expect(Vim.getOption('insertModeEscKeysTimeout', cm, { scope: 'global' })).toBe('456');
    } finally {
        Vim.setOption('pcre', true);
        Vim.setOption('insertModeEscKeysTimeout', 200);
    }
});

it('stops applying later options after an invalid option', async () => {
    vi.stubGlobal('document', {
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
        createTextNode: () => ({ nodeType: 3 }),
    });
    try {
        const view = { state: EditorState.create({ doc: '' }) };
        const cm = new CodeMirror(view);
        cm.operation = fn => fn();
        cm.onBeforeEndOperation = () => {};
        cm.openNotification = vi.fn();
        Vim.maybeInitVimState_(cm);
        await Vim.handleEx(cm, 'set textwidth=42 nonexistent=1 filetype=python');
        expect(cm.getOption('textwidth')).toBe(42);
        expect(cm.getOption('mode')).toBeUndefined();
        expect(cm.openNotification).toHaveBeenCalledOnce();
    } finally {
        vi.unstubAllGlobals();
    }
});
