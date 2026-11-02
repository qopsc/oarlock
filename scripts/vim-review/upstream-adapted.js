import { awaitVimIdle } from './settle.js';

export async function vimTests(CodeMirror, test) {

function eqCursorPos(a, b) {
  if (a.line != b.line || a.ch != b.ch)
    throw failure(
      "Expected cursor position " +
       JSON.stringify([a.line, a.ch]) +
       " to be equal to " +
       JSON.stringify([b.line, b.ch]),
       eqCursorPos
      );
}
function eq(a, b, _reason) {
  if(a != b)
    throw failure("Expected " + a +  " to be equal to " + b, eq);
}
// DOM scroll offsets round to integer CSS pixels; glyph rectangles can be fractional.
function eqPixel(a,b) { if(Math.abs(a-b)>1)throw failure("Pixel alignment differs: "+a+" vs "+b,eqPixel); }
function is(a,reason) {
  if (!a) throw failure("Expected " + a +  " to be truthy"+(reason?": "+reason:""), is);
}
function failure(message, root) {
  var error = new Error(message);
  if (Error.captureStackTrace)
    Error.captureStackTrace(error, root);
  return error;
}

var Pos = CodeMirror.Pos;
CodeMirror.Vim.suppressErrorLogging = true;

var isOldCodeMirror = /^5\./.test(CodeMirror.version);

var code = '' +
' wOrd1 (#%\n' +
' word3] \n' +
'aopop pop 0 1 2 3 4\n' +
' (a) [b] {c} \n' +
'int getchar(void) {\n' +
'  static char buf[BUFSIZ];\n' +
'  static char *bufp = buf;\n' +
'  if (n == 0) {  /* buffer is empty */\n' +
'    n = read(0, buf, sizeof buf);\n' +
'    bufp = buf;\n' +
'  }\n' +
'\n' +
'  return (--n >= 0) ? (unsigned char) *bufp++ : EOF;\n' +
' \n' +
'}\n';

var lines = (function() {
  var lineText = code.split('\n');
  var ret = [];
  for (var i = 0; i < lineText.length; i++) {
    ret[i] = {
      line: i,
      length: lineText[i].length,
      lineText: lineText[i],
      textStart: /^\s*/.exec(lineText[i])[0].length
    };
  }
  return ret;
})();
var endOfDocument = makeCursor(lines.length - 1,
    lines[lines.length - 1].length);
var wordLine = lines[0];
var bigWordLine = lines[1];
var charLine = lines[2];
var bracesLine = lines[3];
var seekBraceLine = lines[4];
var foldingStart = lines[7];
var foldingEnd = lines[11];

var word1 = {
  start: new Pos(wordLine.line, 1),
  end: new Pos(wordLine.line, 5)
};
var word2 = {
  start: new Pos(wordLine.line, word1.end.ch + 2),
  end: new Pos(wordLine.line, word1.end.ch + 4)
};
var word3 = {
  start: new Pos(bigWordLine.line, 1),
  end: new Pos(bigWordLine.line, 5)
};
var bigWord1 = word1;
var bigWord2 = word2;
var bigWord3 = {
  start: new Pos(bigWordLine.line, 1),
  end: new Pos(bigWordLine.line, 7)
};
var bigWord4 = {
  start: new Pos(bigWordLine.line, bigWord1.end.ch + 3),
  end: new Pos(bigWordLine.line, bigWord1.end.ch + 7)
};

var oChars = [ new Pos(charLine.line, 1),
    new Pos(charLine.line, 3),
    new Pos(charLine.line, 7) ];
var pChars = [ new Pos(charLine.line, 2),
    new Pos(charLine.line, 4),
    new Pos(charLine.line, 6),
    new Pos(charLine.line, 8) ];
var numChars = [ new Pos(charLine.line, 10),
    new Pos(charLine.line, 12),
    new Pos(charLine.line, 14),
    new Pos(charLine.line, 16),
    new Pos(charLine.line, 18)];
var parens1 = {
  start: new Pos(bracesLine.line, 1),
  end: new Pos(bracesLine.line, 3)
};
var squares1 = {
  start: new Pos(bracesLine.line, 5),
  end: new Pos(bracesLine.line, 7)
};
var curlys1 = {
  start: new Pos(bracesLine.line, 9),
  end: new Pos(bracesLine.line, 11)
};
var seekOutside = {
  start: new Pos(seekBraceLine.line, 1),
  end: new Pos(seekBraceLine.line, 16)
};
var seekInside = {
  start: new Pos(seekBraceLine.line, 14),
  end: new Pos(seekBraceLine.line, 11)
};
var foldingRangeDown = {
  start: new Pos(foldingStart.line, 3),
  end: new Pos(foldingEnd.line, 0)
};
var foldingRangeUp = {
  start: new Pos(foldingEnd.line, 0),
  end: new Pos(foldingStart.line, 0)
};

function searchHighlighted(vim) {
  return vim.searchState_ && (vim.searchState_.getOverlay() || vim.searchState_.highlightTimeout);
}

async function forEach(arr, func) {
  for (var i = 0; i < arr.length; i++) {
    (await func(arr[i], i, arr));
  }
}

function vimKeyToKeyName(key) {
  return key.replace(/[CS]-|CR|BS/g, function(part) {
    return {"C-": "Ctrl-", "S-": "Shift-", CR: "Return", BS: "Backspace"}[part];
  });
}

async function testVim(name, run, opts, expectedFail) {
  var vimOpts = {
    lineNumbers: true,
    vimMode: true,
    showCursorWhenSelecting: true,
    value: code
  };
  for (var prop in opts) {
    if (opts.hasOwnProperty(prop)) {
      vimOpts[prop] = opts[prop];
    }
  }
  return (await test('vim_' + name, async function() {
    var place = document.getElementById("testground");
    place.style.visibility = "visible";
    var cm = CodeMirror(place, vimOpts);
    var vim = CodeMirror.Vim.maybeInitVimState_(cm);
    CodeMirror.Vim.mapclear();
    CodeMirror.Vim.langmap('');

    cm.focus();
    // workaround for cm5 slow polling in blurred window
    Object.defineProperty(cm.state, "focused", {
        set: function(e) {},
        get: function() {
            return document.activeElement == cm.getInputField();
        }
    });

    var helpers = {
      doKeys: async function() {
        var args = arguments[0]
        if (!Array.isArray(args)) { args = arguments; }
        for (var i = 0; i < args.length; i++) {
          var key = args[i];
          if (key.length > 1 && key[0] == "<" && key.slice(-1) == ">") {
              key = vimKeyToKeyName(key.slice(1, -1));
          }
          cm.refresh();
          typeKey(key);
          (await awaitVimIdle(cm));
          cm.refresh();
        }
      },
      doEx: async function(command) {
        (await helpers.doKeys(':', command, '\n'));
      },
      assertCursorAt: function(line, ch) {
        var pos;
        if (ch == null && typeof line.line == 'number') {
          pos = line;
        } else {
          pos = makeCursor(line, ch);
        }
        eqCursorPos(cm.getCursor(), pos);
      },
      getRegisterController: function() {
        return CodeMirror.Vim.getRegisterController();
      },
      getNotificationText: function() {
        var container = cm.getWrapperElement().querySelector(".cm-vim-message");
        return container && container.textContent;
      }
    };
    CodeMirror.Vim.resetVimGlobalState_();
    var successful = false;
    try {
      await run(cm, vim, helpers);
      successful = true;
    } finally {
      if (successful && !window.verbose) {
        cm.getWrapperElement().remove();
      }
    }
  }, expectedFail));
};
(await testVim('qq@q', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'q', 'l', 'l', 'q'));
  helpers.assertCursorAt(0,2);
  (await helpers.doKeys('@', 'q'));
  helpers.assertCursorAt(0,4);
}, { value: '            '}));
(await testVim('@@', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'q', 'l', 'l', 'q'));
  helpers.assertCursorAt(0,2);
  (await helpers.doKeys('@', 'q'));
  helpers.assertCursorAt(0,4);
  (await helpers.doKeys('@', '@'));
  helpers.assertCursorAt(0,6);
}, { value: '            '}));
var jumplistScene = ''+
  'word\n'+
  '(word)\n'+
  '{word\n'+
  'word.\n'+
  '\n'+
  'word search\n'+
  '}word\n'+
  'word\n'+
  'word\n';
async function testJumplist(name, keys, endPos, startPos) {
  endPos = makeCursor(endPos[0], endPos[1]);
  startPos = makeCursor(startPos[0], startPos[1]);
  (await testVim(name, async function(cm, vim, helpers) {
    CodeMirror.Vim.resetVimGlobalState_();
    cm.setCursor(startPos);
    (await helpers.doKeys.apply(null, keys));
    helpers.assertCursorAt(endPos);
  }, {value: jumplistScene}));
}
(await testJumplist('jumplist_H', ['H', '<C-o>'], [5,2], [5,2]));
(await testJumplist('jumplist_M', ['M', '<C-o>'], [2,2], [2,2]));
(await testJumplist('jumplist_L', ['L', '<C-o>'], [2,2], [2,2]));
(await testJumplist('jumplist_[[', ['[', '[', '<C-o>'], [5,2], [5,2]));
(await testJumplist('jumplist_]]', [']', ']', '<C-o>'], [2,2], [2,2]));
(await testJumplist('jumplist_G', ['G', '<C-o>'], [5,2], [5,2]));
(await testJumplist('jumplist_gg', ['g', 'g', '<C-o>'], [5,2], [5,2]));
(await testJumplist('jumplist_%', ['%', '<C-o>'], [1,5], [1,5]));
(await testJumplist('jumplist_{', ['{', '<C-o>'], [1,5], [1,5]));
(await testJumplist('jumplist_}', ['}', '<C-o>'], [1,5], [1,5]));
(await testJumplist('jumplist_\'', ['m', 'a', 'h', '\'', 'a', 'h', '<C-i>'], [1,0], [1,5]));
(await testJumplist('jumplist_`', ['m', 'a', 'h', '`', 'a', 'h', '<C-i>'], [1,5], [1,5]));
(await testJumplist('jumplist_*_cachedCursor', ['*', '<C-o>'], [1,3], [1,3]));
(await testJumplist('jumplist_#_cachedCursor', ['#', '<C-o>'], [1,3], [1,3]));
(await testJumplist('jumplist_n', ['#', 'n', '<C-o>'], [1,1], [2,3]));
(await testJumplist('jumplist_N', ['#', 'N', '<C-o>'], [1,1], [2,3]));
(await testJumplist('jumplist_repeat_<c-o>', ['*', '*', '*', '3', '<C-o>'], [2,3], [2,3]));
(await testJumplist('jumplist_repeat_<c-i>', ['*', '*', '*', '3', '<C-o>', '2', '<C-i>'], [5,0], [2,3]));
(await testJumplist('jumplist_repeated_motion', ['3', '*', '<C-o>'], [2,3], [2,3]));
(await testJumplist('jumplist_/', ['/', 'dialog\n', '<C-o>'], [2,3], [2,3]));
(await testJumplist('jumplist_?', ['?', 'dialog\n', '<C-o>'], [2,3], [2,3]));
(await testJumplist('jumplist_skip_deleted_mark<c-o>',
             ['*', 'n', 'n', 'k', 'd', 'k', '<C-o>', '<C-o>', '<C-o>'],
             [0,2], [0,2]));
(await testJumplist('jumplist_skip_deleted_mark<c-i>',
             ['*', 'n', 'n', 'k', 'd', 'k', '<C-o>', '<C-i>', '<C-i>'],
             [1,0], [0,2]));

/**
 * @param name Name of the test
 * @param keys An array of keys or a string with a single key to simulate.
 * @param endPos The expected end position of the cursor.
 * @param startPos The position the cursor should start at, defaults to 0, 0.
 */
async function testMotion(name, keys, endPos, startPos) {
  (await testVim(name, async function(cm, vim, helpers) {
    if (!startPos) {
      startPos = new Pos(0, 0);
    }
    cm.setCursor(startPos);
    (await helpers.doKeys(keys));
    helpers.assertCursorAt(endPos);
  }));
}

async function testMotionWithFolding(name, keys, endPos, startPos) {
  (await testVim(name, async function (cm, vim, helpers) {
    cm.foldCode(startPos);
    cm.foldCode(endPos);
    cm.setCursor(startPos);
    (await helpers.doKeys(keys));
    helpers.assertCursorAt(endPos);
  }));
}

function makeCursor(line, ch) {
  return new Pos(line, ch);
}

function offsetCursor(cur, offsetLine, offsetCh) {
  return new Pos(cur.line + offsetLine, cur.ch + offsetCh);
}

// Motion tests
(await testMotion('|', '|', makeCursor(0, 0), makeCursor(0,4)));
(await testMotion('|_repeat', ['3', '|'], makeCursor(0, 2), makeCursor(0,4)));
(await testMotion('h', 'h', makeCursor(0, 0), word1.start));
(await testMotion('h_repeat', ['3', 'h'], offsetCursor(word1.end, 0, -3), word1.end));
(await testMotion('l', 'l', makeCursor(0, 1)));
(await testMotion('Space', 'Space', makeCursor(0, 1)));
(await testMotion('l_repeat', ['2', 'l'], makeCursor(0, 2)));
(await testMotion('j', 'j', offsetCursor(word1.end, 1, 0), word1.end));
(await testMotion('j_repeat', ['2', 'j'], offsetCursor(word1.end, 2, 0), word1.end));
(await testMotion('j_repeat_clip', ['1000', 'j'], endOfDocument));
(await testMotion('k', 'k', offsetCursor(word3.end, -1, 0), word3.end));
(await testMotion('k_repeat', ['2', 'k'], makeCursor(0, 4), makeCursor(2, 4)));
(await testMotion('k_repeat_clip', ['1000', 'k'], makeCursor(0, 4), makeCursor(2, 4)));
(await testMotion('w', 'w', word1.start));
(await testMotion('keepHPos', ['5', 'j', 'j', '7', 'k'], makeCursor(8, 12), makeCursor(12, 12)));
(await testMotion('keepHPosEol', ['$', '2', 'j'], makeCursor(2, 18)));
(await testMotion('w_multiple_newlines_no_space', 'w', makeCursor(12, 2), makeCursor(11, 2)));
(await testMotion('w_multiple_newlines_with_space', 'w', makeCursor(14, 0), makeCursor(12, 51)));
(await testMotion('w_repeat', ['2', 'w'], word2.start));
(await testMotion('w_wrap', ['w'], word3.start, word2.start));
(await testMotion('w_endOfDocument', 'w', endOfDocument, endOfDocument));
(await testMotion('w_start_to_end', ['1000', 'w'], endOfDocument, makeCursor(0, 0)));
(await testMotion('W', 'W', bigWord1.start));
(await testMotion('W_repeat', ['2', 'W'], bigWord3.start, bigWord1.start));
(await testMotion('e', 'e', word1.end));
(await testMotion('e_repeat', ['2', 'e'], word2.end));
(await testMotion('e_wrap', 'e', word3.end, word2.end));
(await testMotion('e_endOfDocument', 'e', endOfDocument, endOfDocument));
(await testMotion('e_start_to_end', ['1000', 'e'], endOfDocument, makeCursor(0, 0)));
(await testMotion('b', 'b', word3.start, word3.end));
(await testMotion('b_repeat', ['2', 'b'], word2.start, word3.end));
(await testMotion('b_wrap', 'b', word2.start, word3.start));
(await testMotion('b_startOfDocument', 'b', makeCursor(0, 0), makeCursor(0, 0)));
(await testMotion('b_end_to_start', ['1000', 'b'], makeCursor(0, 0), endOfDocument));
(await testMotion('ge', ['g', 'e'], word2.end, word3.end));
(await testMotion('ge_repeat', ['2', 'g', 'e'], word1.end, word3.start));
(await testMotion('ge_wrap', ['g', 'e'], word2.end, word3.start));
(await testMotion('ge_startOfDocument', ['g', 'e'], makeCursor(0, 0),
    makeCursor(0, 0)));
(await testMotion('ge_end_to_start', ['1000', 'g', 'e'], makeCursor(0, 0), endOfDocument));
(await testMotion('gg', ['g', 'g'], makeCursor(lines[0].line, lines[0].textStart),
    makeCursor(3, 1)));
(await testMotion('gg_repeat', ['3', 'g', 'g'],
    makeCursor(lines[2].line, lines[2].textStart)));
(await testMotion('G', 'G',
    makeCursor(lines[lines.length - 1].line, lines[lines.length - 1].textStart),
    makeCursor(3, 1)));
(await testMotion('G_repeat', ['3', 'G'], makeCursor(lines[2].line,
    lines[2].textStart)));
// TODO: Make the test code long enough to test Ctrl-F and Ctrl-B.
(await testMotion('0', '0', makeCursor(0, 0), makeCursor(0, 8)));
(await testMotion('^', '^', makeCursor(0, lines[0].textStart), makeCursor(0, 8)));
(await testMotion('+', '+', makeCursor(1, lines[1].textStart), makeCursor(0, 8)));
(await testMotion('-', '-', makeCursor(0, lines[0].textStart), makeCursor(1, 4)));
(await testMotion('_', ['6','_'], makeCursor(5, lines[5].textStart), makeCursor(0, 8)));
(await testMotion('$', '$', makeCursor(0, lines[0].length - 1), makeCursor(0, 1)));
(await testMotion('$_repeat', ['2', '$'], makeCursor(1, lines[1].length - 1),
    makeCursor(0, 3)));
(await testMotion('$', ['v', '$'], makeCursor(0, lines[0].length), makeCursor(0, 1)));
(await testMotion('f', ['f', 'p'], pChars[0], makeCursor(charLine.line, 0)));
(await testMotion('f_repeat', ['2', 'f', 'p'], pChars[2], pChars[0]));
(await testMotion('f_num', ['f', '2'], numChars[2], makeCursor(charLine.line, 0)));
(await testMotion('f<S-Space>', ['f', '<S-Space>'], offsetCursor(word1.end, 0, 1), word1.start));
(await testMotion('t', ['t','p'], offsetCursor(pChars[0], 0, -1),
    makeCursor(charLine.line, 0)));
(await testMotion('t_repeat', ['2', 't', 'p'], offsetCursor(pChars[2], 0, -1),
    pChars[0]));
(await testMotion('F', ['F', 'p'], pChars[0], pChars[1]));
(await testMotion('F_repeat', ['2', 'F', 'p'], pChars[0], pChars[2]));
(await testMotion('T', ['T', 'p'], offsetCursor(pChars[0], 0, 1), pChars[1]));
(await testMotion('T_repeat', ['2', 'T', 'p'], offsetCursor(pChars[0], 0, 1), pChars[2]));
(await testMotion('%_parens', ['%'], parens1.end, parens1.start));
(await testMotion('%_squares', ['%'], squares1.end, squares1.start));
(await testMotion('%_braces', ['%'], curlys1.end, curlys1.start));
(await testMotion('%_seek_outside', ['%'], seekOutside.end, seekOutside.start));
(await testMotion('%_seek_inside', ['%'], seekInside.end, seekInside.start));

// Motion with folding tests
(await testMotionWithFolding('j_with_folding', 'j', foldingRangeDown.end, foldingRangeDown.start));
(await testMotionWithFolding('k_with_folding', 'k', foldingRangeUp.end, foldingRangeUp.start));

(await testVim('%_seek_skip', async function(cm, vim, helpers) {
  cm.setCursor(0,0);
  (await helpers.doKeys(['%']));
  helpers.assertCursorAt(0,9);
}, {value:'01234"("()'}));
(await testVim('%_skip_string', async function(cm, vim, helpers) {
  cm.setCursor(0,0);
  (await helpers.doKeys(['%']));
  helpers.assertCursorAt(0,4);
  cm.setCursor(0,2);
  (await helpers.doKeys(['%']));
  helpers.assertCursorAt(0,0);
}, {value:'(")")'}));
(await testVim('%_skip_comment', async function(cm, vim, helpers) {
  cm.setCursor(0,0);
  (await helpers.doKeys(['%']));
  helpers.assertCursorAt(0,6);
  cm.setCursor(0,3);
  (await helpers.doKeys(['%']));
  helpers.assertCursorAt(0,0);
}, {value:'(/*)*/)'}));
// Make sure that moving down after going to the end of a line always leaves you
// at the end of a line, but preserves the offset in other cases
(await testVim('Changing lines after Eol operation', async function(cm, vim, helpers) {
  cm.setCursor(0,0);
  (await helpers.doKeys(['$']));
  (await helpers.doKeys(['j']));
  // After moving to Eol and then down, we should be at Eol of line 2
  helpers.assertCursorAt(new Pos(1, lines[1].length - 1));
  (await helpers.doKeys(['j']));
  // After moving down, we should be at Eol of line 3
  helpers.assertCursorAt(new Pos(2, lines[2].length - 1));
  (await helpers.doKeys(['h']));
  (await helpers.doKeys(['j']));
  // After moving back one space and then down, since line 4 is shorter than line 2, we should
  // be at Eol of line 2 - 1
  helpers.assertCursorAt(new Pos(3, lines[3].length - 1));
  (await helpers.doKeys(['j']));
  (await helpers.doKeys(['j']));
  // After moving down again, since line 3 has enough characters, we should be back to the
  // same place we were at on line 1
  helpers.assertCursorAt(new Pos(5, lines[2].length - 2));
}));
//making sure gj and gk recover from clipping
(await testVim('gj_gk_clipping', async function(cm,vim,helpers){
  cm.setCursor(0, 1);
  (await helpers.doKeys('g','j','g','j'));
  helpers.assertCursorAt(2, 1);
  (await helpers.doKeys('g','j'));
  helpers.assertCursorAt(2, 1);
  (await helpers.doKeys('g','k','g','k'));
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('9','g','j'));
  helpers.assertCursorAt(2, 1);
},{value: 'line 1\n\nline 2'}));
//testing a mix of j/k and gj/gk
(await testVim('j_k_and_gj_gk', async function(cm,vim,helpers){
  cm.setSize(120);
  cm.setCursor(0, 0);
  //go to the last character on the first line
  (await helpers.doKeys('$'));
  //move up/down on the column within the wrapped line
  //side-effect: cursor is not locked to eol anymore
  (await helpers.doKeys('g','k'));
  var cur=cm.getCursor();
  eq(cur.line,0);
  is((cur.ch<176),'gk didn\'t move cursor back (1)');
  (await helpers.doKeys('g','j'));
  helpers.assertCursorAt(0, 176);
  //should move to character 177 on line 2 (j/k preserve character index within line)
  (await helpers.doKeys('j'));
  //due to different line wrapping, the cursor can be on a different screen-x now
  //gj and gk preserve screen-x on movement, much like moveV
  (await helpers.doKeys('3','g','k'));
  cur=cm.getCursor();
  eq(cur.line,1);
  is((cur.ch<176),'gk didn\'t move cursor back (2)');
  (await helpers.doKeys('g','j','2','g','j'));
  //should return to the same character-index
  (await helpers.doKeys('k'));
  helpers.assertCursorAt(0, 176);
},{ lineWrapping:true, value: 'This line is intentionally long. It tests movements of gj and gk over wrapped lines. Starts on the end of this line, then makes a step up and back to set the origin for j and k.\nThis line is supposed to be even longer than the previous. I will jump here and make another wiggle with gj and gk, before I jump back to the line above. Both wiggles should not change my cursor\'s target character but both j/k and gj/gk change each other\'s reference position.'}));
(await testVim('gj_gk', async function(cm, vim, helpers) {
  cm.setSize(120);
  // Test top of document edge case.
  cm.setCursor(0, 4);
  (await helpers.doKeys('g', 'j'));
  (await helpers.doKeys('10', 'g', 'k'));
  helpers.assertCursorAt(0, 4);

  // Test moving down preserves column position.
  (await helpers.doKeys('g', 'j'));
  var pos1 = cm.getCursor();
  var expectedPos2 = new Pos(0, (pos1.ch - 4) * 2 + 4);
  (await helpers.doKeys('g', 'j'));
  helpers.assertCursorAt(expectedPos2);

  // Move to the last character
  cm.setCursor(0, 0);
  // Move left to reset HSPos
  (await helpers.doKeys('h'));
  // Test bottom of document edge case.
  (await helpers.doKeys('100', 'g', 'j'));
  var endingPos = cm.getCursor();
  is(endingPos.ch != 0, 'gj should not be on wrapped line 0');
  var topLeftCharCoords = cm.charCoords(makeCursor(0, 0));
  var endingCharCoords = cm.charCoords(endingPos);
  is(topLeftCharCoords.left == endingCharCoords.left, 'gj should end up on column 0');
},{ lineNumbers: false, lineWrapping:true, value: 'Thislineisintentionallylongtotestmovementofgjandgkoverwrappedlines.' }));
(await testVim('g0_g$', async function(cm, vim, helpers) {
  cm.setSize(120);
  var topLeftCharCoords = cm.charCoords(makeCursor(0, 0));
  cm.setCursor(0, 4);
  (await helpers.doKeys('g', 'Down'));
  var secondLineCoords = cm.charCoords(cm.getCursor());
  is(secondLineCoords.top > topLeftCharCoords.top);
  is(secondLineCoords.left > topLeftCharCoords.left);

  (await helpers.doKeys('g', '0'));
  var start = cm.getCursor();
  var startCoords = cm.charCoords(start);
  is(start.ch != 0);
  is(startCoords.left == topLeftCharCoords.left);
  is(secondLineCoords.top === startCoords.top);
  is(secondLineCoords.left > startCoords.left);

  (await helpers.doKeys('g', '$'));
  var end = cm.getCursor();
  var endCoords = cm.charCoords(end);
  is(startCoords.left < endCoords.left);
  is(startCoords.top == endCoords.top);
  is(start.ch < end.ch && end.ch < cm.getValue().length / 2);
  is(/\.$/.test(cm.getValue()));
  (await helpers.doKeys('$', 'g', '0', 'd', 'g', '$'));
  is(!/\.$/.test(cm.getValue()));
  
},{ lineNumbers: false, lineWrapping:true, value: 'This line is long to test movement of g$ and g0 over wrapped lines.' }));
(await testVim('}', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('}'));
  helpers.assertCursorAt(1, 0);
  cm.setCursor(0, 0);
  (await helpers.doKeys('2', '}'));
  helpers.assertCursorAt(4, 0);
  cm.setCursor(0, 0);
  (await helpers.doKeys('6', '}'));
  helpers.assertCursorAt(5, 0);
}, { value: 'a\n\nb\nc\n\nd' }));
(await testVim('{', async function(cm, vim, helpers) {
  cm.setCursor(5, 0);
  (await helpers.doKeys('{'));
  helpers.assertCursorAt(4, 0);
  cm.setCursor(5, 0);
  (await helpers.doKeys('2', '{'));
  helpers.assertCursorAt(1, 0);
  cm.setCursor(5, 0);
  (await helpers.doKeys('6', '{'));
  helpers.assertCursorAt(0, 0);
}, { value: 'a\n\nb\nc\n\nd' }));
(await testVim('(', async function(cm, vim, helpers) {
  cm.setCursor(6, 23);
  (await helpers.doKeys('('));
  helpers.assertCursorAt(6, 14);
  (await helpers.doKeys('2', '('));
  helpers.assertCursorAt(5, 0);
  (await helpers.doKeys('('));
  helpers.assertCursorAt(4, 0);
  (await helpers.doKeys('('));
  helpers.assertCursorAt(3, 0);
  (await helpers.doKeys('('));
  helpers.assertCursorAt(2, 0);
  (await helpers.doKeys('('));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('('));
  helpers.assertCursorAt(0, 0);
}, { value: 'sentence1.\n\n\nsentence2\n\nsentence3. sentence4\n   sentence5? sentence6!' }));
(await testVim(')', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('2', ')'));
  helpers.assertCursorAt(3, 0);
  (await helpers.doKeys(')'));
  helpers.assertCursorAt(4, 0);
  (await helpers.doKeys(')'));
  helpers.assertCursorAt(5, 0);
  (await helpers.doKeys(')'));
  helpers.assertCursorAt(5, 11);
  (await helpers.doKeys(')'));
  helpers.assertCursorAt(6, 14);
  (await helpers.doKeys(')'));
  helpers.assertCursorAt(6, 23);
  (await helpers.doKeys(')'));
  helpers.assertCursorAt(6, 23);
}, { value: 'sentence1.\n\n\nsentence2\n\nsentence3. sentence4\n   sentence5? sentence6!' }));
(await testVim('paragraph_motions', async function(cm, vim, helpers) {
  cm.setCursor(10, 0);
  (await helpers.doKeys('{'));
  helpers.assertCursorAt(4, 0);
  (await helpers.doKeys('{'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('2', '}'));
  helpers.assertCursorAt(7, 0);
  (await helpers.doKeys('2', '}'));
  helpers.assertCursorAt(16, 0);

  cm.setCursor(9, 0);
  (await helpers.doKeys('}'));
  helpers.assertCursorAt(14, 0);

  cm.setCursor(6, 0);
  (await helpers.doKeys('}'));
  helpers.assertCursorAt(7, 0);

  // ip inside empty space
  cm.setCursor(10, 0);
  (await helpers.doKeys('v', 'i', 'p'));
  eqCursorPos(new Pos(7, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(12, 0), cm.getCursor('head'));
  (await helpers.doKeys('i', 'p'));
  eqCursorPos(new Pos(7, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(13, 1), cm.getCursor('head'));
  (await helpers.doKeys('2', 'i', 'p'));
  eqCursorPos(new Pos(7, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(16, 1), cm.getCursor('head'));

  // should switch to visualLine mode
  cm.setCursor(14, 0);
  (await helpers.doKeys('<Esc>', 'v', 'i', 'p'));
  helpers.assertCursorAt(14, 0);

  cm.setCursor(14, 0);
  (await helpers.doKeys('<Esc>', 'V', 'i', 'p'));
  eqCursorPos(new Pos(16, 1), cm.getCursor('head'));

  // ap inside empty space
  cm.setCursor(10, 0);
  (await helpers.doKeys('<Esc>', 'v', 'a', 'p'));
  eqCursorPos(new Pos(7, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(13, 1), cm.getCursor('head'));
  (await helpers.doKeys('a', 'p'));
  eqCursorPos(new Pos(7, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(16, 1), cm.getCursor('head'));

  cm.setCursor(13, 0);
  (await helpers.doKeys('v', 'a', 'p'));
  eqCursorPos(new Pos(13, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(14, 0), cm.getCursor('head'));

  cm.setCursor(16, 0);
  (await helpers.doKeys('v', 'a', 'p'));
  eqCursorPos(new Pos(14, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(16, 1), cm.getCursor('head'));

  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'a', 'p'));
  eqCursorPos(new Pos(0, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(4, 0), cm.getCursor('head'));

  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'i', 'p'));
  var register = helpers.getRegisterController().getRegister();
  eq('a\na\n', register.toString());
  is(register.linewise);
  (await helpers.doKeys('3', 'j', 'p'));
  (await helpers.doKeys('y', 'i', 'p'));
  is(register.linewise);
  eq('b\na\na\nc\n', register.toString());
}, { value: 'a\na\n\n\n\nb\nc\n\n\n\n\n\n\nd\n\ne\nf' }));

(await testVim('sentence_selections', async function(cm, vim, helpers) {
  // vis at beginning of line
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'i', 's'));
  eqCursorPos(new Pos(0, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(0, 14), cm.getCursor('head'));

  // vas at beginning of line
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'a', 's'));
  eqCursorPos(new Pos(0, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(0, 15), cm.getCursor('head'));

  // vis on sentence end
  cm.setCursor(0, 13);
  (await helpers.doKeys('v', 'i', 's'));
  eqCursorPos(new Pos(0, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(0, 14), cm.getCursor('head'));

  // vas on sentence end
  cm.setCursor(0, 13);
  (await helpers.doKeys('v', 'a', 's'));
  eqCursorPos(new Pos(0, 0), cm.getCursor('anchor'));
  eqCursorPos(new Pos(0, 15), cm.getCursor('head'));

  // vis at sentence end, no whitespace after it
  cm.setCursor(1, 18);
  (await helpers.doKeys('v', 'i', 's'));
  eqCursorPos(new Pos(1, 13), cm.getCursor('anchor'));
  eqCursorPos(new Pos(1, 19), cm.getCursor('head'));

  // vas at sentence end, no whitespace after it
  cm.setCursor(1, 18);
  (await helpers.doKeys('v', 'a', 's'));
  eqCursorPos(new Pos(1, 12), cm.getCursor('anchor'));
  eqCursorPos(new Pos(1, 19), cm.getCursor('head'));

  // vis at sentence beginning, on whitespace
  cm.setCursor(0, 14);
  (await helpers.doKeys('v', 'i', 's'));
  eqCursorPos(new Pos(0, 14), cm.getCursor('anchor'));
  eqCursorPos(new Pos(0, 29), cm.getCursor('head'));

  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'i', 's'));
  var register = helpers.getRegisterController().getRegister();
  eq('Test sentence.', register.toString());

  // return to original value
  (await helpers.doKeys('u'));

  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'a', 's'));
  register = helpers.getRegisterController().getRegister();
  eq('Test sentence. ', register.toString());

  // return to original value
  (await helpers.doKeys('u'));

  cm.setCursor(1, 20);
  (await helpers.doKeys('c', 'a', 's', '<Esc>'));
  register = helpers.getRegisterController().getRegister();
  eq('Test.', register.toString());

  // return to original value
  (await helpers.doKeys('u'));

  cm.setCursor(3, 11);
  (await helpers.doKeys('y', 'a', 's'));
  register = helpers.getRegisterController().getRegister();
  eq('This is more text. ', register.toString());

  cm.setCursor(3, 31);
  (await helpers.doKeys('y', 'a', 's'));
  register = helpers.getRegisterController().getRegister();
  eq(' No end of sentence symbol', register.toString());

}, { value: 'Test sentence. Test question?\nAgain.Never. Again.Test.\n\nHello. This is more text. No end of sentence symbol\n' }));

(await testVim('w_text_object_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('v', '3', 'a', 'w'));
  eq('w1  ++  w_2   ', cm.getSelection());
  (await helpers.doKeys('<Esc>', 'v', 'a', 'w'));
  eq('   \n w3', cm.getSelection());
  
  (await helpers.doKeys('2', 'a', 'w'));
  eq('   \n w3   xx \n', cm.getSelection());
  (await helpers.doKeys('a', 'w'));
  eq('   \n w3   xx \n\nw4', cm.getSelection());

  cm.setValue("  w0 word1  word2  word3    word4");
  cm.setCursor(0, 8);
  (await helpers.doKeys('c', '3', 'a', 'w'));
  eq('  w0 word4', cm.getValue());
}, { value: ' w1  ++  w_2   \n w3   xx \n\nw4\nword5\nword6' }));

// Operator tests
(await testVim('dl', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 0);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'l'));
  eq('word1 ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' ', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1 ' }));
(await testVim('dl_eol', async function(cm, vim, helpers) {
  cm.setCursor(0, 6);
  (await helpers.doKeys('d', 'l'));
  eq(' word1', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' ', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 5);
}, { value: ' word1 ' }));
(await testVim('dl_repeat', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 0);
  cm.setCursor(curStart);
  (await helpers.doKeys('2', 'd', 'l'));
  eq('ord1 ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' w', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1 ' }));
(await testVim('dh', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'h'));
  eq(' wrd1 ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('o', register.toString());
  is(!register.linewise);
  eqCursorPos(offsetCursor(curStart, 0 , -1), cm.getCursor());
}, { value: ' word1 ' }));
(await testVim('dj', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'j'));
  eq(' word3', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' word1\nword2\n', register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, 1);
}, { value: ' word1\nword2\n word3' }));
(await testVim('dj_end_of_document', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'j'));
  eq('', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' word1 \n', register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, 0);
}, { value: ' word1 ' }));
(await testVim('dk', async function(cm, vim, helpers) {
  var curStart = makeCursor(1, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'k'));
  eq(' word3', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' word1\nword2\n', register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, 1);
}, { value: ' word1\nword2\n word3' }));
(await testVim('dk_start_of_document', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'k'));
  eq('', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' word1 \n', register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, 0);
}, { value: ' word1 ' }));
(await testVim('dw_space', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 0);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'w'));
  eq('word1 ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' ', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1 ' }));
(await testVim('dw_word', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 1);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'w'));
  eq(' word2', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1 ', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1 word2' }));
(await testVim('dw_unicode_word', async function(cm, vim, helpers) {
  (await helpers.doKeys('d', 'w'));
  eq(cm.getValue().length, 10);
  (await helpers.doKeys('d', 'w'));
  eq(cm.getValue().length, 6);
  (await helpers.doKeys('d', 'w'));
  eq(cm.getValue().length, 5);
  (await helpers.doKeys('d', 'e'));
  eq(cm.getValue().length, 2);
}, { value: '  \u0562\u0561\u0580\u0587\xbbe\xb5g  ' }));
(await testVim('dw_only_word', async function(cm, vim, helpers) {
  // Test that if there is only 1 word left, dw deletes till the end of the
  // line.
  cm.setCursor(0, 1);
  (await helpers.doKeys('d', 'w'));
  eq(' ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1 ', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 0);
}, { value: ' word1 ' }));
(await testVim('dw_eol', async function(cm, vim, helpers) {
  // Assert that dw does not delete the newline if last word to delete is at end
  // of line.
  cm.setCursor(0, 1);
  (await helpers.doKeys('d', 'w'));
  eq(' \nword2', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 0);
}, { value: ' word1\nword2' }));
(await testVim('dw_eol_with_multiple_newlines', async function(cm, vim, helpers) {
  // Assert that dw does not delete the newline if last word to delete is at end
  // of line and it is followed by multiple newlines.
  cm.setCursor(0, 1);
  (await helpers.doKeys('d', 'w'));
  eq(' \n\nword2', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 0);
}, { value: ' word1\n\nword2' }));
(await testVim('dw_empty_line_followed_by_whitespace', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'w'));
  eq('  \nword', cm.getValue());
}, { value: '\n  \nword' }));
(await testVim('dw_empty_line_followed_by_word', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'w'));
  eq('word', cm.getValue());
}, { value: '\nword' }));
(await testVim('dw_empty_line_followed_by_empty_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'w'));
  eq('\n', cm.getValue());
}, { value: '\n\n' }));
(await testVim('dw_whitespace_followed_by_whitespace', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'w'));
  eq('\n   \n', cm.getValue());
}, { value: '  \n   \n' }));
(await testVim('dw_whitespace_followed_by_empty_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'w'));
  eq('\n\n', cm.getValue());
}, { value: '  \n\n' }));
(await testVim('dw_word_whitespace_word', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'w'));
  eq('\n   \nword2', cm.getValue());
}, { value: 'word1\n   \nword2'}));
(await testVim('dw_end_of_document', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('d', 'w'));
  eq('\nab', cm.getValue());
}, { value: '\nabc' }));
(await testVim('dw_repeat', async function(cm, vim, helpers) {
  // Assert that dw does delete newline if it should go to the next line, and
  // that repeat works properly.
  cm.setCursor(0, 1);
  (await helpers.doKeys('d', '2', 'w'));
  eq(' ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1\nword2', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 0);
}, { value: ' word1\nword2' }));
(await testVim('de_word_start_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'e'));
  eq('\n\n', cm.getValue());
}, { value: 'word\n\n' }));
(await testVim('de_word_end_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doKeys('d', 'e'));
  eq('wor', cm.getValue());
}, { value: 'word\n\n\n' }));
(await testVim('de_whitespace_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'e'));
  eq('', cm.getValue());
}, { value: '   \n\n\n' }));
(await testVim('de_end_of_document', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('d', 'e'));
  eq('\nab', cm.getValue());
}, { value: '\nabc' }));
(await testVim('db_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('d', 'b'));
  eq('\n\n', cm.getValue());
}, { value: '\n\n\n' }));
(await testVim('db_word_start_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('d', 'b'));
  eq('\nword', cm.getValue());
}, { value: '\n\nword' }));
(await testVim('db_word_end_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(2, 3);
  (await helpers.doKeys('d', 'b'));
  eq('\n\nd', cm.getValue());
}, { value: '\n\nword' }));
(await testVim('db_whitespace_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('d', 'b'));
  eq('', cm.getValue());
}, { value: '\n   \n' }));
(await testVim('db_start_of_document', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'b'));
  eq('abc\n', cm.getValue());
}, { value: 'abc\n' }));
(await testVim('dge_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doKeys('d', 'g', 'e'));
  // Note: In real VIM the result should be '', but it's not quite consistent,
  // since 2 newlines are deleted. But in the similar case of word\n\n, only
  // 1 newline is deleted. We'll diverge from VIM's behavior since it's much
  // easier this way.
  eq('\n', cm.getValue());
}, { value: '\n\n' }));
(await testVim('dge_word_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doKeys('d', 'g', 'e'));
  eq('wor\n', cm.getValue());
}, { value: 'word\n\n'}));
(await testVim('dge_whitespace_and_empty_lines', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('d', 'g', 'e'));
  eq('', cm.getValue());
}, { value: '\n  \n' }));
(await testVim('dge_start_of_document', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', 'g', 'e'));
  eq('bc\n', cm.getValue());
}, { value: 'abc\n' }));
(await testVim('d_inclusive', async function(cm, vim, helpers) {
  // Assert that when inclusive is set, the character the cursor is on gets
  // deleted too.
  var curStart = makeCursor(0, 1);
  cm.setCursor(curStart);
  (await helpers.doKeys('d', 'e'));
  eq('  ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1 ' }));
(await testVim('d_reverse', async function(cm, vim, helpers) {
  // Test that deleting in reverse works.
  cm.setCursor(1, 0);
  (await helpers.doKeys('d', 'b'));
  eq(' word2 ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1\n', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 1);
}, { value: ' word1\nword2 ' }));
(await testVim('dd', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(1, 0));
  var expectedLineCount = cm.lineCount() - 1;
  (await helpers.doKeys('d', 'd'));
  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, lines[1].textStart);
}));
(await testVim('dd_prefix_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(2, 0));
  var expectedLineCount = cm.lineCount() - 2;
  (await helpers.doKeys('2', 'd', 'd'));
  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, lines[2].textStart);
}));
(await testVim('dd_motion_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(2, 0));
  var expectedLineCount = cm.lineCount() - 2;
  (await helpers.doKeys('d', '2', 'd'));
  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, lines[2].textStart);
}));
(await testVim('dd_multiply_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(6, 0));
  var expectedLineCount = cm.lineCount() - 6;
  (await helpers.doKeys('2', 'd', '3', 'd'));
  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, lines[6].textStart);
}));
(await testVim('dd_lastline', async function(cm, vim, helpers) {
  cm.setCursor(cm.lineCount(), 0);
  var expectedLineCount = cm.lineCount() - 1;
  (await helpers.doKeys('d', 'd'));
  eq(expectedLineCount, cm.lineCount());
  helpers.assertCursorAt(cm.lineCount() - 1, 0);
}));
(await testVim('dd_only_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  var expectedRegister = cm.getValue() + "\n";
  (await helpers.doKeys('d','d'));
  eq(1, cm.lineCount());
  eq('', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedRegister, register.toString());
}, { value: "thisistheonlyline" }));
(await testVim('cG', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('c', 'G', 'inserted'));
  eq('inserted', cm.getValue());
  helpers.assertCursorAt(0, 8);
  cm.setValue("    indented\nlines");
  (await helpers.doKeys('<Esc>', 'c', 'G', 'inserted'));
  eq('    inserted', cm.getValue());
}, { value: 'line1\nline2\n'}));
// Yank commands should behave the exact same as d commands, expect that nothing
// gets deleted.
(await testVim('yw_repeat', async function(cm, vim, helpers) {
  // Assert that yw does yank newline if it should go to the next line, and
  // that repeat works properly.
  var curStart = makeCursor(0, 1);
  cm.setCursor(curStart);
  (await helpers.doKeys('y', '2', 'w'));
  eq(' word1\nword2', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1\nword2', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1\nword2' }));
(await testVim('yy_multiply_repeat', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(6, 0));
  var expectedLineCount = cm.lineCount();
  (await helpers.doKeys('2', 'y', '3', 'y'));
  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}));
(await testVim('2dd_blank_P', async function(cm, vim, helpers) {
  (await helpers.doKeys('2', 'd', 'd', 'P'));
  eq('\na\n\n', cm.getValue());
}, { value: '\na\n\n' }));
// Change commands behave like d commands except that it also enters insert
// mode. In addition, when the change is linewise, an additional newline is
// inserted so that insert mode starts on that line.
(await testVim('cw', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('c', '2', 'w'));
  eq(' word3', cm.getValue());
  helpers.assertCursorAt(0, 0);
}, { value: 'word1 word2 word3'}));
(await testVim('cw_repeat', async function(cm, vim, helpers) {
  // Assert that cw does delete newline if it should go to the next line, and
  // that repeat works properly.
  var curStart = makeCursor(0, 1);
  cm.setCursor(curStart);
  (await helpers.doKeys('c', '2', 'w'));
  eq(' ', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1\nword2', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: ' word1\nword2' }));
(await testVim('cc_multiply_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(6, 0));
  var expectedLineCount = cm.lineCount() - 5;
  (await helpers.doKeys('2', 'c', '3', 'c'));
  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  eq('vim-insert', cm.getOption('keyMap'));
}));
(await testVim('ct', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('c', 't', 'w'));
  eq('  word1  word3', cm.getValue());
  (await helpers.doKeys('<Esc>', 'c', '|'));
  eq(' word3', cm.getValue());
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('<Esc>', '2', 'u', 'w', 'h'));
  (await helpers.doKeys('c', '2', 'g', 'e'));
  eq('  wordword3', cm.getValue());
}, { value: '  word1  word2  word3'}));
(await testVim('cc_should_not_append_to_document', async function(cm, vim, helpers) {
  var expectedLineCount = cm.lineCount();
  cm.setCursor(cm.lastLine(), 0);
  (await helpers.doKeys('c', 'c'));
  eq(expectedLineCount, cm.lineCount());
}));
function fillArray(val, times) {
  var arr = [];
  for (var i = 0; i < times; i++) {
    arr.push(val);
  }
  return arr;
}
(await testVim('c_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'l', 'l', 'c'));
  (await helpers.doKeys('hello'));
  eq('1hello\n5hello\nahellofg', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(2, 3);
  (await helpers.doKeys('<C-v>', '2', 'k', 'h', 'C'));
  (await helpers.doKeys('world'));
  eq('1hworld\n5hworld\nahworld', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));
(await testVim('c_visual_block_replay', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'c'));
  (await helpers.doKeys('fo'));
  eq('1fo4\n5fo8\nafodefg', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('.'));
  eq('foo4\nfoo8\nfoodefg', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));
(await testVim('I_visual_block_replay', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'I'));
  (await helpers.doKeys('+-'));
  eq('12+-34\n56+-78\nab+-cdefg\nxyz', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  // ensure that repeat location doesn't depend on last selection
  cm.setCursor(3, 2);
  (await helpers.doKeys('g', 'v'));
  eq("+-34\n+-78\n+-cd", cm.getSelection());
  cm.setCursor(0, 3);
  (await helpers.doKeys('<C-v>', '1', 'j', '2', 'l'));
  eq("-34\n-78", cm.getSelection());
  cm.setCursor(0, 0);
  eq("", cm.getSelection());
  (await helpers.doKeys('g', 'v'));
  eq("-34\n-78", cm.getSelection());
  cm.setCursor(1, 1);
  (await helpers.doKeys('.'));
  eq('12+-34\n5+-6+-78\na+-b+-cdefg\nx+-yz', cm.getValue());
}, {value: '1234\n5678\nabcdefg\nxyz'}));

(await testVim('visual_block_backwards', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('3', 'l'));
  (await helpers.doKeys('<C-v>', '2', 'j', '2', '<Left>'));
  eq('123\n678\nbcd', cm.getSelection());
  (await helpers.doKeys('A'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('A', '<Esc>'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('g', 'v'));
  eq('123\n678\nbcd', cm.getSelection());
  (await helpers.doKeys('x'));
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('g', 'v'));
  eq('A4 \nA9 \nAef', cm.getSelection());
}, {value: '01234 line 1\n56789 line 2\nabcdefg line 3\nline 4'}));

(await testVim('d_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'l', 'l', 'd'));
  eq('1\n5\nafg', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));
(await testVim('D_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'D'));
  eq('1\n5\na', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));

(await testVim('s_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'l', 'l', 's'));
  (await helpers.doKeys('hello{'));
  eq('1hello{\n5hello{\nahello{fg\n', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(2, 3);
  (await helpers.doKeys('<C-v>', '1', 'k', 'h', 'S'));
  (await helpers.doKeys('world'));
  eq('1hello{\n  world\n', cm.getValue());
}, {value: '1234\n5678\nabcdefg\n'}));

(await testVim('gcc', async function(cm, vim, helpers) {
  (await helpers.doKeys('g', 'c', 'c'));
  eq('// var line1\nline2\nline3', cm.getValue());
  (await helpers.doKeys('2', 'g', 'c', 'c'));
  eq('// // var line1\n// line2\nline3', cm.getValue());
}, { value: 'var line1\nline2\nline3', mode: ''}));
// Test mode change event. It should only fire once per mode transition.
(await testVim('on_mode_change', async function(cm, vim, helpers) {
  var modeHist = [];
  function callback(arg) {
    var subMode = arg.subMode ? ':' + arg.subMode : '';
    modeHist.push(arg.mode + subMode);
  }
  (await helpers.doKeys('<Esc>', '<Esc>'));
  cm.on('vim-mode-change', callback);
  async function test(key, mode) {
    modeHist.length = 0;
    (await helpers.doKeys(key));
    if (key == '<C-c>' && !isOldCodeMirror)
      await delay(0);
    eq(modeHist.join(';'), mode);
  }
  (await test('v', 'visual'));
  (await test('c', 'insert'));
  (await test('<Esc>', 'normal'));
  (await test('<C-v>', 'visual:blockwise'));
  (await test('I', 'insert'));
  (await test('<Esc>', 'normal'));
  (await test('R', 'replace'));
  (await test('x', ''));
  (await test('<C-[>', 'normal'));
  (await test('v', 'visual'));
  (await test('V', 'visual:linewise'));
  (await test('<C-v>', 'visual:blockwise'));
  (await test('v', 'visual'));
  await (await test('<C-c>', 'normal'));
  (await test('a', 'insert'));
  (await test('<Esc>', 'normal'));
  (await test('v', 'visual'));
  (await test(':', '')); // Event for Command-line mode not implemented.
  (await test('y\n', 'normal'));
  (await test(":startinsert\n", "insert"));
}));

// Swapcase commands edit in place and do not modify registers.
(await testVim('g~w_repeat', async function(cm, vim, helpers) {
  // Assert that dw does delete newline if it should go to the next line, and
  // that repeat works properly.
  var curStart = makeCursor(0, 1);
  cm.setCursor(curStart);
  (await helpers.doKeys('g', '~', '2', 'w'));
  eq(' WORD1\nWORD2', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1\nword2' }));
(await testVim('g~g~', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  var expectedLineCount = cm.lineCount();
  var expectedValue = cm.getValue().toUpperCase();
  (await helpers.doKeys('2', 'g', '~', '3', 'g', '~'));
  eq(expectedValue, cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
}, { value: ' word1\nword2\nword3\nword4\nword5\nword6' }));
(await testVim('gu_and_gU', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 7);
  var value = cm.getValue();
  cm.setCursor(curStart);
  (await helpers.doKeys('2', 'g', 'U', 'w'));
  eq(cm.getValue(), 'wa wb xX WC wd');
  eqCursorPos(curStart, cm.getCursor());
  (await helpers.doKeys('2', 'g', 'u', 'w'));
  eq(cm.getValue(), value);

  (await helpers.doKeys('2', 'g', 'U', 'B'));
  eq(cm.getValue(), 'wa WB Xx wc wd');
  eqCursorPos(makeCursor(0, 3), cm.getCursor());

  cm.setCursor(makeCursor(0, 4));
  (await helpers.doKeys('g', 'u', 'i', 'w'));
  eq(cm.getValue(), 'wa wb Xx wc wd');
  eqCursorPos(makeCursor(0, 3), cm.getCursor());

  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);

  cm.setCursor(curStart);
  cm.setValue('abc efg\nxyz');
  (await helpers.doKeys('g', 'U', 'g', 'U'));
  eq(cm.getValue(), 'ABC EFG\nxyz');
  (await helpers.doKeys('g', 'u', 'u'));
  eq(cm.getValue(), 'abc efg\nxyz');
  eqCursorPos(makeCursor(0, 0), cm.getCursor());
  (await helpers.doKeys('g', 'U', '2', 'U'));
  eq(cm.getValue(), 'ABC EFG\nXYZ');
}, { value: 'wa wb xx wc wd' }));
(await testVim('g?', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 7);
  var value = cm.getValue();
  cm.setCursor(curStart);
  (await helpers.doKeys('2', 'g', '?', 'w'));
  eq(cm.getValue(), 'wa wb xk jp wd');
  eqCursorPos(curStart, cm.getCursor());
  (await helpers.doKeys('2', 'g', '?', 'w'));
  eq(cm.getValue(), value);

  (await helpers.doKeys('2', 'g', '?', 'B'));
  eq(cm.getValue(), 'wa jo kx wc wd');
  eqCursorPos(makeCursor(0, 3), cm.getCursor());

  cm.setCursor(makeCursor(0, 4));
  (await helpers.doKeys('g', '?', 'i', 'w'));
  eq(cm.getValue(), 'wa wb kx wc wd');
  eqCursorPos(makeCursor(0, 3), cm.getCursor());

  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  
  cm.setCursor(curStart);
  cm.setValue('abc efg();\nxyz');
  (await helpers.doKeys('g', '?', 'g', '?'));
  eq(cm.getValue(), 'nop rst();\nxyz');
  (await helpers.doKeys('g', '?', '?'));
  eq(cm.getValue(), 'abc efg();\nxyz');
  eqCursorPos(makeCursor(0, 0), cm.getCursor());
  (await helpers.doKeys('g', '?', '2', '?'));
  eq(cm.getValue(), 'nop rst();\nklm');

  cm.setCursor(curStart);
  cm.setValue('hello\nworld');
  (await helpers.doKeys('l','<C-v>','l','j','g','?'));
  eq(cm.getValue(), 'hrylo\nwbeld');
}, { value: 'wa wb xx wc wd' }));
(await testVim('visual_block_~', async function(cm, vim, helpers) {
  cm.setCursor(1, 1);
  (await helpers.doKeys('<C-v>', 'l', 'l', 'j', '~'));
  helpers.assertCursorAt(1, 1);
  eq('hello\nwoRLd\naBCDe', cm.getValue());
  cm.setCursor(2, 0);
  (await helpers.doKeys('v', 'l', 'l', '~'));
  helpers.assertCursorAt(2, 0);
  eq('hello\nwoRLd\nAbcDe', cm.getValue());
},{value: 'hello\nwOrld\nabcde' }));
(await testVim('._swapCase_visualBlock', async function(cm, vim, helpers) {
  (await helpers.doKeys('<C-v>', 'j', 'j', 'l', '~'));
  cm.setCursor(0, 3);
  (await helpers.doKeys('.'));
  eq('HelLO\nWorLd\nAbcdE', cm.getValue());
},{value: 'hEllo\nwOrlD\naBcDe' }));
(await testVim('._delete_visualBlock', async function(cm, vim, helpers) {
  (await helpers.doKeys('<C-v>', 'j', 'x'));
  eq('ive\ne\nsome\nsugar', cm.getValue());
  (await helpers.doKeys('.'));
  eq('ve\n\nsome\nsugar', cm.getValue());
  (await helpers.doKeys('j', 'j', '.'));
  eq('ve\n\nome\nugar', cm.getValue());
  (await helpers.doKeys('u'));
  if (!isOldCodeMirror) helpers.assertCursorAt(2, 0);
  eq('ve\n\nsome\nsugar', cm.getValue());
  (await helpers.doKeys('<C-r>'));
  helpers.assertCursorAt(2, 0);
  eq('ve\n\nome\nugar', cm.getValue());
  (await helpers.doKeys('.'));
  helpers.assertCursorAt(2, 0);
  eq('ve\n\nme\ngar', cm.getValue());
},{value: 'give\nme\nsome\nsugar' }));
(await testVim('>{motion}', async function(cm, vim, helpers) {
  cm.setCursor(1, 3);
  var expectedLineCount = cm.lineCount();
  var expectedValue = '   word1\n  word2\nword3 ';
  (await helpers.doKeys('>', 'k'));
  eq(expectedValue, cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 3);
}, { value: ' word1\nword2\nword3 ', indentUnit: 2 }));
(await testVim('>>', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedLineCount = cm.lineCount();
  var expectedValue = '   word1\n  word2\nword3 ';
  (await helpers.doKeys('2', '>', '>'));
  eq(expectedValue, cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 3);
}, { value: ' word1\nword2\nword3 ', indentUnit: 2 }));
(await testVim('<{motion}', async function(cm, vim, helpers) {
  cm.setCursor(1, 3);
  var expectedLineCount = cm.lineCount();
  var expectedValue = ' word1\nword2\nword3 ';
  (await helpers.doKeys('<', 'k'));
  eq(expectedValue, cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 1);
}, { value: '   word1\n  word2\nword3 ', indentUnit: 2 }));
(await testVim('<<', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedLineCount = cm.lineCount();
  var expectedValue = ' word1\nword2\nword3 ';
  (await helpers.doKeys('2', '<', '<'));
  eq(expectedValue, cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 1);
}, { value: '   word1\n  word2\nword3 ', indentUnit: 2 }));
(await testVim('=', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doKeys('<C-v>', 'j', 'j'));
  var expectedValue = 'word1\nword2\nword3';
  (await helpers.doKeys('='));
  eq(expectedValue, cm.getValue());
}, { value: '   word1\n  word2\n  word3', indentUnit: 2 }));
(await testVim('><visualblock', async function(cm, vim, helpers) {
  cm.setCursor(0, 6);
  (await helpers.doKeys('<C-v>', 'j', 'j'));
  (await helpers.doKeys('4', '>'));
  eq('  word        1\n  word        2\n  word        3', cm.getValue());
  (await helpers.doKeys('g', 'v', '14', '<'));
  eq('  word1\n  word2\n  word3', cm.getValue());
}, { value: '  word1\n  word2\n  word3', indentUnit: 2 }));


// Edit tests
async function testEdit(name, before, pos, edit, after, opts) {
  if (!opts) opts = {};
  opts.value = before;
  return (await testVim(name, async function(cm, vim, helpers) {
             var ch = before.search(pos)
             var line = before.substring(0, ch).split('\n').length - 1;
             if (line) {
               ch = before.substring(0, ch).split('\n').pop().length;
             }
             cm.setCursor(line, ch);
             (await helpers.doKeys.apply(this, edit.split('')));
             eq(after, cm.getValue());
           }, opts));
}

// These Delete tests effectively cover word-wise Change, Visual & Yank.
// Tabs are used as differentiated whitespace to catch edge cases.
// Normal word:
(await testEdit('diw_mid_spc', 'foo \tbAr\t baz', /A/, 'diw', 'foo \t\t baz'));
(await testEdit('daw_mid_spc', 'foo \tbAr\t baz', /A/, 'daw', 'foo \tbaz'));
(await testEdit('diw_mid_punct', 'foo \tbAr.\t baz', /A/, 'diw', 'foo \t.\t baz'));
(await testEdit('daw_mid_punct', 'foo \tbAr.\t baz', /A/, 'daw', 'foo.\t baz'));
(await testEdit('diw_mid_punct2', 'foo \t,bAr.\t baz', /A/, 'diw', 'foo \t,.\t baz'));
(await testEdit('daw_mid_punct2', 'foo \t,bAr.\t baz', /A/, 'daw', 'foo \t,.\t baz'));
(await testEdit('diw_start_spc', 'bAr \tbaz', /A/, 'diw', ' \tbaz'));
(await testEdit('daw_start_spc', 'bAr \tbaz', /A/, 'daw', 'baz'));
(await testEdit('diw_start_punct', 'bAr. \tbaz', /A/, 'diw', '. \tbaz'));
(await testEdit('daw_start_punct', 'bAr. \tbaz', /A/, 'daw', '. \tbaz'));
(await testEdit('diw_end_spc', 'foo \tbAr', /A/, 'diw', 'foo \t'));
(await testEdit('daw_end_spc', 'foo \tbAr', /A/, 'daw', 'foo'));
(await testEdit('diw_end_punct', 'foo \tbAr.', /A/, 'diw', 'foo \t.'));
(await testEdit('daw_end_punct', 'foo \tbAr.', /A/, 'daw', 'foo.'));
(await testEdit('diw_space_word1', 'foo \t\n\tbar.', /\t/, 'diw', 'foo\n\tbar.'));
(await testEdit('diw_space_word2', 'foo +bar.', / /, 'diw', 'foo+bar.'));
(await testEdit('diw_space_word3', ' foo bar.', / /, 'diw', 'foo bar.'));
// Big word:
(await testEdit('diW_mid_spc', 'foo \tbAr\t baz', /A/, 'diW', 'foo \t\t baz'));
(await testEdit('daW_mid_spc', 'foo \tbAr\t baz', /A/, 'daW', 'foo \tbaz'));
(await testEdit('diW_mid_punct', 'foo \tbAr.\t baz', /A/, 'diW', 'foo \t\t baz'));
(await testEdit('daW_mid_punct', 'foo \tbAr.\t baz', /A/, 'daW', 'foo \tbaz'));
(await testEdit('diW_mid_punct2', 'foo \t,bAr.\t baz', /A/, 'diW', 'foo \t\t baz'));
(await testEdit('daW_mid_punct2', 'foo \t,bAr.\t baz', /A/, 'daW', 'foo \tbaz'));
(await testEdit('diW_start_spc', 'bAr\t baz', /A/, 'diW', '\t baz'));
(await testEdit('daW_start_spc', 'bAr\t baz', /A/, 'daW', 'baz'));
(await testEdit('diW_start_punct', 'bAr.\t baz', /A/, 'diW', '\t baz'));
(await testEdit('daW_start_punct', 'bAr.\t baz', /A/, 'daW', 'baz'));
(await testEdit('diW_end_spc', 'foo \tbAr', /A/, 'diW', 'foo \t'));
(await testEdit('daW_end_spc', 'foo \tbAr', /A/, 'daW', 'foo'));
(await testEdit('diW_end_punct', 'foo \tbAr.', /A/, 'diW', 'foo \t'));
(await testEdit('daW_end_punct', 'foo \tbAr.', /A/, 'daW', 'foo'));
(await testEdit('diW_space_word2', 'foo +bar.', / /, 'diW', 'foo+bar.'));
// Deleting text objects
//    Open and close on same line
(await testEdit('di(_open_spc', 'foo (bAr) baz', /\(/, 'di(', 'foo () baz'));
(await testEdit('di)_open_spc', 'foo (bAr) baz', /\(/, 'di)', 'foo () baz'));
(await testEdit('dib_open_spc', 'foo (bAr) baz', /\(/, 'dib', 'foo () baz'));
(await testEdit('da(_open_spc', 'foo (bAr) baz', /\(/, 'da(', 'foo  baz'));
(await testEdit('da)_open_spc', 'foo (bAr) baz', /\(/, 'da)', 'foo  baz'));

(await testEdit('di(_middle_spc', 'foo (bAr) baz', /A/, 'di(', 'foo () baz'));
(await testEdit('di)_middle_spc', 'foo (bAr) baz', /A/, 'di)', 'foo () baz'));
(await testEdit('da(_middle_spc', 'foo (bAr) baz', /A/, 'da(', 'foo  baz'));
(await testEdit('da)_middle_spc', 'foo (bAr) baz', /A/, 'da)', 'foo  baz'));

(await testEdit('di(_close_spc', 'foo (bAr) baz', /\)/, 'di(', 'foo () baz'));
(await testEdit('di)_close_spc', 'foo (bAr) baz', /\)/, 'di)', 'foo () baz'));
(await testEdit('da(_close_spc', 'foo (bAr) baz', /\)/, 'da(', 'foo  baz'));
(await testEdit('da)_close_spc', 'foo (bAr) baz', /\)/, 'da)', 'foo  baz'));

(await testEdit('di`', 'foo `bAr` baz', /`/, 'di`', 'foo `` baz'));
(await testEdit('di>', 'foo <bAr> baz', /</, 'di>', 'foo <> baz'));
(await testEdit('da<', 'foo <bAr> baz', /</, 'da<', 'foo  baz'));

//  delete around and inner b.
(await testEdit('dab_on_(_should_delete_around_()block', 'o( in(abc) )', /\(a/, 'dab', 'o( in )'));

//  delete around and inner B.
(await testEdit('daB_on_{_should_delete_around_{}block', 'o{ in{abc} }', /{a/, 'daB', 'o{ in }'));
(await testEdit('diB_on_{_should_delete_inner_{}block', 'o{ in{abc} }', /{a/, 'diB', 'o{ in{} }'));

(await testEdit('da{_on_{_should_delete_inner_block', 'o{ in{abc} }', /{a/, 'da{', 'o{ in }'));
(await testEdit('di[_on_(_should_not_delete', 'foo (bAr) baz', /\(/, 'di[', 'foo (bAr) baz'));
(await testEdit('di[_on_)_should_not_delete', 'foo (bAr) baz', /\)/, 'di[', 'foo (bAr) baz'));
(await testEdit('da[_on_(_should_not_delete', 'foo (bAr) baz', /\(/, 'da[', 'foo (bAr) baz'));
(await testEdit('da[_on_)_should_not_delete', 'foo (bAr) baz', /\)/, 'da[', 'foo (bAr) baz'));
(await testMotion('di(_outside_should_stay', ['d', 'i', '('], new Pos(0, 0), new Pos(0, 0)));

//  Open and close on different lines, equally indented
(await testEdit('di{_middle_spc', 'a{\n\tbar\n}b', /r/, 'di{', 'a{}b'));
(await testEdit('di}_middle_spc', 'a{\n\tbar\n}b', /r/, 'di}', 'a{}b'));
(await testEdit('da{_middle_spc', 'a{\n\tbar\n}b', /r/, 'da{', 'ab'));
(await testEdit('da}_middle_spc', 'a{\n\tbar\n}b', /r/, 'da}', 'ab'));
(await testEdit('daB_middle_spc', 'a{\n\tbar\n}b', /r/, 'daB', 'ab'));

// open and close on diff lines, open indented less than close
(await testEdit('di{_middle_spc', 'a{\n\tbar\n\t}b', /r/, 'di{', 'a{}b'));
(await testEdit('di}_middle_spc', 'a{\n\tbar\n\t}b', /r/, 'di}', 'a{}b'));
(await testEdit('da{_middle_spc', 'a{\n\tbar\n\t}b', /r/, 'da{', 'ab'));
(await testEdit('da}_middle_spc', 'a{\n\tbar\n\t}b', /r/, 'da}', 'ab'));

// open and close on diff lines, open indented more than close
(await testEdit('di[_middle_spc', 'a\t[\n\tbar\n]b', /r/, 'di[', 'a\t[]b'));
(await testEdit('di]_middle_spc', 'a\t[\n\tbar\n]b', /r/, 'di]', 'a\t[]b'));
(await testEdit('da[_middle_spc', 'a\t[\n\tbar\n]b', /r/, 'da[', 'a\tb'));
(await testEdit('da]_middle_spc', 'a\t[\n\tbar\n]b', /r/, 'da]', 'a\tb'));

// open and close on diff lines, open indented more than close
(await testEdit('di<_middle_spc', 'a\t<\n\tbar\n>b', /r/, 'di<', 'a\t<>b'));
(await testEdit('di>_middle_spc', 'a\t<\n\tbar\n>b', /r/, 'di>', 'a\t<>b'));
(await testEdit('da<_middle_spc', 'a\t<\n\tbar\n>b', /r/, 'da<', 'a\tb'));
(await testEdit('da>_middle_spc', 'a\t<\n\tbar\n>b', /r/, 'da>', 'a\tb'));

// deleting tag objects
(await testEdit('dat_noop', '<outer><inner>hello</inner></outer>', /n/, 'dat', '<outer><inner>hello</inner></outer>'));
(await testEdit('dat_open_tag', '<outer><inner>hello</inner></outer>', /n/, 'dat', '<outer></outer>', {
  mode: 'xml'
}));
(await testEdit('dat_inside_tag', '<outer><inner>hello</inner></outer>', /l/, 'dat', '<outer></outer>', {
  mode: 'xml'
}));
(await testEdit('dat_close_tag', '<outer><inner>hello</inner></outer>', /\//, 'dat', '<outer></outer>', {
  mode: 'xml'
}));

(await testEdit('dit_open_tag', '<outer><inner>hello</inner></outer>', /n/, 'dit', '<outer><inner></inner></outer>', {
  mode: 'xml'
}));
(await testEdit('dit_inside_tag', '<outer><inner>hello</inner></outer>', /l/, 'dit', '<outer><inner></inner></outer>', {
  mode: 'xml'
}));
(await testEdit('dit_close_tag', '<outer><inner>hello</inner></outer>', /\//, 'dit', '<outer><inner></inner></outer>', {
  mode: 'xml'
}));

async function testSelection(name, before, pos, keys, sel) {
  return (await testVim(name, async function(cm, vim, helpers) {
             var ch = before.search(pos)
             var line = before.substring(0, ch).split('\n').length - 1;
             if (line) {
               ch = before.substring(0, ch).split('\n').pop().length;
             }
             cm.setCursor(line, ch);
             (await helpers.doKeys.apply(this, keys.split('')));
             eq(sel, cm.getSelection());
           }, {value: before}));
}
(await testSelection('viw_middle_spc', 'foo \tbAr\t baz', /A/, 'viw', 'bAr'));
(await testSelection('vaw_middle_spc', 'foo \tbAr\t baz', /A/, 'vaw', 'bAr\t '));
(await testSelection('viw_middle_punct', 'foo \tbAr,\t baz', /A/, 'viw', 'bAr'));
(await testSelection('vaW_middle_punct', 'foo \tbAr,\t baz', /A/, 'vaW', 'bAr,\t '));
(await testSelection('viw_start_spc', 'foo \tbAr\t baz', /b/, 'viw', 'bAr'));
(await testSelection('viw_end_spc', 'foo \tbAr\t baz', /r/, 'viw', 'bAr'));
(await testSelection('viw_eol', 'foo \tbAr', /r/, 'viw', 'bAr'));
(await testSelection('vi{_middle_spc', 'a{\n\tbar\n\t}b', /r/, 'vi{', '\n\tbar\n\t'));
(await testSelection('va{_middle_spc', 'a{\n\tbar\n\t}b', /r/, 'va{', '{\n\tbar\n\t}'));
(await testSelection('va{outside', 'xa{\n\tbar\n\t}b', /x/, 'va{', '{\n\tbar\n\t}'));

(await testVim('ci" for two strings', async function(cm, vim, helpers) {
  cm.setCursor(0, 11);
  (await helpers.doKeys('c', 'i', '"'));
  eq('   "":  "string2";', cm.getValue());
  (await helpers.doKeys('<Esc>', 'u', 'f', '"', '<Right>'));
  (await helpers.doKeys('c', 'i', '"'));
  eq('   "string1""string2";', cm.getValue());
  (await helpers.doKeys('<Esc>', 'u', 'f', '"'));
  (await helpers.doKeys('c', 'i', '"'));
  eq('   "string1":  "";', cm.getValue());
}, {value: '   "string1":  "string2";'}));

(await testVim('mouse_select', async function(cm, vim, helpers) {
  cm.setSelection(new Pos(0, 2), new Pos(0, 4), {origin: '*mouse'});
  is(cm.state.vim.visualMode);
  is(!cm.state.vim.visualLine);
  is(!cm.state.vim.visualBlock);
  (await helpers.doKeys('<Esc>'));
  is(!cm.somethingSelected());
  (await helpers.doKeys('g', 'v'));
  eq('cd', cm.getSelection());
}, {value: 'abcdef'}));

// Operator-motion tests
(await testVim('D', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doKeys('D'));
  eq(' wo\nword2\n word3', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('rd1', register.toString());
  is(!register.linewise);
  helpers.assertCursorAt(0, 2);
}, { value: ' word1\nword2\n word3' }));
(await testVim('C', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('C'));
  eq(' wo\nword2\n word3', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('rd1', register.toString());
  is(!register.linewise);
  eqCursorPos(curStart, cm.getCursor());
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: ' word1\nword2\n word3' }));
(await testVim('Y', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('Y'));
  eq(' word1\nword2\n word3', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq(' word1\n', register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, 3);
}, { value: ' word1\nword2\n word3' }));
(await testVim('Yy_blockwise', async function(cm, vim, helpers) {
  (await helpers.doKeys('<C-v>', 'j', '2', 'l', 'Y'));
  (await helpers.doKeys('G', 'p', 'g', 'g'));
  (await helpers.doKeys('<C-v>', 'j', '2', 'l', 'y'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('$', 'p'));
  eq('123456123\n123456123\n123456\n123456', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('123\n123', register.toString());
  is(register.blockwise);
  helpers.assertCursorAt(0, 6);
  (await helpers.doKeys('$', 'j', 'p'));
  (await helpers.doKeys('$', 'j', 'P'));
  eq("123456123\n123456123123\n123456   121233\n123456     123", cm.getValue());
}, { value: '123456\n123456\n' }));
(await testVim('~', async function(cm, vim, helpers) {
  (await helpers.doKeys('3', '~'));
  eq('ABCdefg', cm.getValue());
  helpers.assertCursorAt(0, 3);
}, { value: 'abcdefg' }));

// Action tests
(await testVim('ctrl-a', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-a>'));
  eq('-9', cm.getValue());
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('2','<C-a>'));
  eq('-7', cm.getValue());
}, {value: '-10'}));
(await testVim('ctrl-x', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-x>'));
  eq('-1', cm.getValue());
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('2','<C-x>'));
  eq('-3', cm.getValue());
}, {value: '0'}));
(await testVim('<C-x>/<C-a> search forward', async function(cm, vim, helpers) {
  (await forEach(['<C-x>', '<C-a>'], async function(key) {
    cm.setCursor(0, 0);
    (await helpers.doKeys(key));
    helpers.assertCursorAt(0, 5);
    (await helpers.doKeys('l'));
    (await helpers.doKeys(key));
    helpers.assertCursorAt(0, 10);
    cm.setCursor(0, 11);
    (await helpers.doKeys(key));
    helpers.assertCursorAt(0, 11);
  }));
}, {value: '__jmp1 jmp2 jmp'}));
(await testVim('insert_ctrl_o', async function(cm, vim, helpers) {
  (await helpers.doKeys('i'));
  is(vim.insertMode);
  (await helpers.doKeys('<C-o>'));
  is(!vim.insertMode);
  (await helpers.doKeys('3', 'w'));
  is(vim.insertMode);
  eqCursorPos(makeCursor(0, 14), cm.getCursor());
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'one two three here' }));
(await testVim('insert_ctrl_u', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 10);
  cm.setCursor(curStart);
  (await helpers.doKeys('a'));
  (await helpers.doKeys('<C-u>'));
  eq('', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word1/word2', register.toString());
  is(!register.linewise);
  var curEnd = makeCursor(0, 0);
  eqCursorPos(curEnd, cm.getCursor());
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'word1/word2' }));
(await testVim('insert_ctrl_w', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 10);
  cm.setCursor(curStart);
  (await helpers.doKeys('a'));
  (await helpers.doKeys('<C-w>'));
  eq('word1/', cm.getValue());
  var register = helpers.getRegisterController().getRegister();
  eq('word2', register.toString());
  is(!register.linewise);
  var curEnd = makeCursor(0, 6);
  eqCursorPos(curEnd, cm.getCursor());
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'word1/word2' }));
(await testVim('normal_ctrl_w', async function(cm, vim, helpers) {
  var curStart = makeCursor(0, 3);
  cm.setCursor(curStart);
  (await helpers.doKeys('<C-w>'));
  eq('word', cm.getValue());
  var curEnd = makeCursor(0, 3);
  helpers.assertCursorAt(0,3);
  eqCursorPos(curEnd, cm.getCursor());
  eq('vim', cm.getOption('keyMap'));
}, {value: 'word'}));
(await testVim('a', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('a'));
  helpers.assertCursorAt(0, 2);
  eq('vim-insert', cm.getOption('keyMap'));
}));
(await testVim('a_eol', async function(cm, vim, helpers) {
  cm.setCursor(0, lines[0].length - 1);
  (await helpers.doKeys('a'));
  helpers.assertCursorAt(0, lines[0].length);
  eq('vim-insert', cm.getOption('keyMap'));
}));
(await testVim('a with surrogate characters', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('a'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  eq('😀test', cm.getValue());
}, {value: '😀'}));
(await testVim('A_endOfSelectedArea', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'j', 'l'));
  (await helpers.doKeys('A'));
  helpers.assertCursorAt(1, 2);
  eq('vim-insert', cm.getOption('keyMap'));
}, {value: 'foo\nbar'}));
(await testVim('i', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('i'));
  helpers.assertCursorAt(0, 1);
  eq('vim-insert', cm.getOption('keyMap'));
}));
(await testVim('i with surrogate characters', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  eq('test😀', cm.getValue());
}, { value: '😀' }));
(await testVim('i_repeat', async function(cm, vim, helpers) {
  (await helpers.doKeys('3', 'i'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  eq('testtesttest', cm.getValue());
  helpers.assertCursorAt(0, 11);
}, { value: '' }));
(await testVim('i_repeat_delete', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('2', 'i'));
  (await helpers.doKeys('z'));
  (await helpers.doKeys('Backspace', 'Backspace'));
  (await helpers.doKeys('<Esc>'));
  eq('abe', cm.getValue());
  helpers.assertCursorAt(0, 1);
}, { value: 'abcde' }));
(await testVim('insert', async function(cm, vim, helpers) {
  (await helpers.doKeys('i'));
  eq('vim-insert', cm.getOption('keyMap'));
  eq(false, cm.state.overwrite);
  (await helpers.doKeys('<Ins>'));
  eq('vim-replace', cm.getOption('keyMap'));
  eq(true, cm.state.overwrite);
  (await helpers.doKeys('<Ins>'));
  eq('vim-insert', cm.getOption('keyMap'));
  eq(false, cm.state.overwrite);
}));
(await testVim('i_backspace', async function(cm, vim, helpers) {
  cm.setCursor(0, 10);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('Backspace'));
  helpers.assertCursorAt(0, 9);
  eq('012345678', cm.getValue());
}, { value: '0123456789'}));
(await testVim('i_overwrite_backspace', async function(cm, vim, helpers) {
  cm.setCursor(0, 10);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('<Ins>'));
  (await helpers.doKeys('Backspace'));
  helpers.assertCursorAt(new Pos(0, 9, "after"));
  eq('0123456789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('i_forward_delete', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('Delete'));
  helpers.assertCursorAt(0, 3);
  eq('A124\nBCD', cm.getValue());
  (await helpers.doKeys('Delete'));
  helpers.assertCursorAt(0, 3);
  eq('A12\nBCD', cm.getValue());
  (await helpers.doKeys('Delete'));
  helpers.assertCursorAt(0, 3);
  eq('A12BCD', cm.getValue());
}, { value: 'A1234\nBCD'}));
(await testVim('forward_delete', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doKeys('<Del>'));
  helpers.assertCursorAt(0, 3);
  eq('A124\nBCD', cm.getValue());
  (await helpers.doKeys('<Del>'));
  helpers.assertCursorAt(0, 2);
  eq('A12\nBCD', cm.getValue());
  (await helpers.doKeys('<Del>'));
  helpers.assertCursorAt(0, 1);
  eq('A1\nBCD', cm.getValue());
}, { value: 'A1234\nBCD'}));
(await testVim('A', async function(cm, vim, helpers) {
  (await helpers.doKeys('A'));
  helpers.assertCursorAt(0, lines[0].length);
  eq('vim-insert', cm.getOption('keyMap'));
}));
(await testVim('A_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'l', 'A'));
  (await helpers.doKeys('hello'));
  eq('testhello\nmehello\npleahellose', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('.'));
  // TODO this doesn't work yet
  // eq('teshellothello\nme hello hello\nplehelloahellose', cm.getValue());
}, {value: 'test\nme\nplease'}));
(await testVim('I', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('I'));
  helpers.assertCursorAt(0, lines[0].textStart);
  eq('vim-insert', cm.getOption('keyMap'));
}));
(await testVim('I_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('3', 'I'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  eq('testtesttestblah', cm.getValue());
  helpers.assertCursorAt(0, 11);
}, { value: 'blah' }));
(await testVim('I_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'l', 'I'));
  (await helpers.doKeys('hello'));
  eq('hellotest\nhellome\nhelloplease', cm.getValue());
}, {value: 'test\nme\nplease'}));
(await testVim('o', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('o'));
  eq('word1\n\nword2', cm.getValue());
  helpers.assertCursorAt(1, 0);
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'word1\nword2' }));
(await testVim('o_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('3', 'o'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  eq('\ntest\ntest\ntest', cm.getValue());
  helpers.assertCursorAt(3, 3);
}, { value: '' }));
(await testVim('O', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('O'));
  eq('\nword1\nword2', cm.getValue());
  helpers.assertCursorAt(0, 0);
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'word1\nword2' }));
(await testVim('J', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('J'));
  var expectedValue = 'word1  word2\nword3\n word4';
  eq(expectedValue, cm.getValue());
  helpers.assertCursorAt(0, expectedValue.indexOf('word2') - 1);
}, { value: 'word1 \n    word2\nword3\n word4' }));
(await testVim('J_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('3', 'J'));
  var expectedValue = 'word1  word2 word3\n word4';
  eq(expectedValue, cm.getValue());
  helpers.assertCursorAt(0, expectedValue.indexOf('word3') - 1);
}, { value: 'word1 \n    word2\nword3\n word4' }));
(await testVim('gJ', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('g', 'J'));
  eq('word1word2 \n word3', cm.getValue());
  helpers.assertCursorAt(0, 5);
  (await helpers.doKeys('g', 'J'));
  eq('word1word2  word3', cm.getValue());
  helpers.assertCursorAt(0, 11);
}, { value: 'word1\nword2 \n word3' }));
(await testVim('gi', async function(cm, vim, helpers) {
  cm.setCursor(1, 5);
  (await helpers.doKeys('g', 'I'));
  (await helpers.doKeys('a', 'a', '<Esc>', 'k'));
  eq('12\naa  xxxx', cm.getValue());
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('g', 'i'));
  helpers.assertCursorAt(1, 2);
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: '12\n  xxxx' }));
(await testVim('p', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().pushText('"', 'yank', 'abc\ndef', false);
  (await helpers.doKeys('p'));
  eq('__abc\ndef_', cm.getValue());
  helpers.assertCursorAt(0, 2);
  (await helpers.doKeys('y', 'e', 'p'));
  eq('__aabcbc\ndef_', cm.getValue());
  helpers.assertCursorAt(0, 5);
  (await helpers.doKeys('u'));
  // helpers.assertCursorAt(0, 2); // TODO  undo should return  to the same position

}, { value: '___' }));
(await testVim('p_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().getRegister('a').setText('abc\ndef', false);
  (await helpers.doKeys('"', 'a', 'p'));
  eq('__abc\ndef_', cm.getValue());
  helpers.assertCursorAt(0, 2);
}, { value: '___' }));
(await testVim('p_wrong_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().getRegister('a').setText('abc\ndef', false);
  (await helpers.doKeys('p'));
  eq('___', cm.getValue());
  helpers.assertCursorAt(0, 1);
}, { value: '___' }));
(await testVim('p_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().pushText('"', 'yank', '  a\nd\n', true);
  (await helpers.doKeys('2', 'p'));
  eq('___\n  a\nd\n  a\nd', cm.getValue());
  helpers.assertCursorAt(1, 2);
}, { value: '___' }));
(await testVim('p_lastline', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().pushText('"', 'yank', '  a\nd', true);
  (await helpers.doKeys('2', 'p'));
  eq('___\n  a\nd\n  a\nd', cm.getValue());
  helpers.assertCursorAt(1, 2);
}, { value: '___' }));
(await testVim(']p_first_indent_is_smaller', async function(cm, vim, helpers) {
  helpers.getRegisterController().pushText('"', 'yank', '  abc\n    def\n', true);
  (await helpers.doKeys(']', 'p'));
  eq('  ___\n  abc\n    def', cm.getValue());
}, { value: '  ___' }));
(await testVim(']p_first_indent_is_larger', async function(cm, vim, helpers) {
  helpers.getRegisterController().pushText('"', 'yank', '    abc\n  def\n', true);
  (await helpers.doKeys(']', 'p'));
  eq('  ___\n  abc\ndef', cm.getValue());
}, { value: '  ___' }));
(await testVim(']p_with_tab_indents', async function(cm, vim, helpers) {
  helpers.getRegisterController().pushText('"', 'yank', '\t\tabc\n\t\t\tdef\n', true);
  (await helpers.doKeys(']', 'p'));
  eq('\t___\n\tabc\n\t\tdef', cm.getValue());
}, { value: '\t___', indentWithTabs: true}));
(await testVim(']p_with_spaces_translated_to_tabs', async function(cm, vim, helpers) {
  helpers.getRegisterController().pushText('"', 'yank', '  abc\n    def\n', true);
  (await helpers.doKeys(']', 'p'));
  eq('\t___\n\tabc\n\t\tdef', cm.getValue());
}, { value: '\t___', indentWithTabs: true, tabSize: 2 }));
(await testVim('[p', async function(cm, vim, helpers) {
  helpers.getRegisterController().pushText('"', 'yank', '  abc\n    def\n', true);
  (await helpers.doKeys('[', 'p'));
  eq('  abc\n    def\n  ___', cm.getValue());
}, { value: '  ___' }));
(await testVim('P', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().pushText('"', 'yank', 'abc\ndef', false);
  (await helpers.doKeys('P'));
  eq('_abc\ndef__', cm.getValue());
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('y', 'e', 'P'));
  eq('_abcabc\ndef__', cm.getValue());
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('u'));
  // helpers.assertCursorAt(0, 1); // TODO  undo should return  to the same position
}, { value: '___' }));
(await testVim('P_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  helpers.getRegisterController().pushText('"', 'yank', '  a\nd\n', true);
  (await helpers.doKeys('2', 'P'));
  eq('  a\nd\n  a\nd\n___', cm.getValue());
  helpers.assertCursorAt(0, 2);
}, { value: '___' }));
(await testVim('r', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('3', 'r', 'u'));
  eq('wuuuet\nanother', cm.getValue(),'3r failed');
  helpers.assertCursorAt(0, 3);
  cm.setCursor(0, 4);
  (await helpers.doKeys('v', 'j', 'h', 'r', '<Space>'));
  eq('wuuu  \n    her', cm.getValue(),'Replacing selection by space-characters failed');
  cm.setValue("ox");
  (await helpers.doKeys('r', '<C-c>'));
  eq('ox', cm.getValue());
  (await helpers.doKeys('r', '<Del>'));
  eq('ox', cm.getValue());
  (await helpers.doKeys('r', '<CR>'));
  eq('\nx', cm.getValue());
}, { value: 'wordet\nanother' }));
(await testVim('r with surrogate characters', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('r', 'u'));
  eq('u', cm.getValue());
}, { value: '😀' }));
(await testVim('r_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(2, 3);
  (await helpers.doKeys('<C-v>', 'k', 'k', 'h', 'h', 'r', 'l'));
  eq('1lll\n5lll\nalllefg', cm.getValue());
  (await helpers.doKeys('<C-v>', 'l', 'j', 'r', '<Space>'));
  eq('1  l\n5  l\nalllefg', cm.getValue());
  cm.setCursor(2, 0);
  (await helpers.doKeys('o'));
  (await helpers.doKeys('\t\t'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('<C-v>', 'h', 'h', 'r', 'r'));
  eq('1  l\n5  l\nalllefg\nrrrrrrrr', cm.getValue());
}, {value: '1234\n5678\nabcdefg', indentWithTabs: true}));
(await testVim('r_visual with surrogate characters', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'r', 'u'));
  eq('u', cm.getValue());
}, { value: '😀' }));
(await testVim('r_visual_block with surrogate characters', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', 'r', 'u'));
  eq('u', cm.getValue());
}, { value: '😀' }));
(await testVim('R', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('R'));
  helpers.assertCursorAt(0, 1);
  eq('vim-replace', cm.getOption('keyMap'));
  is(cm.state.overwrite, 'Setting overwrite state failed');
}));
(await testVim('R_visual', async function(cm, vim, helpers) {
  (await helpers.doKeys('<C-v>', 'j', 'R', '0', '<Esc>'));
  eq('0\nb33\nc44\nc55', cm.getValue());
  (await helpers.doKeys('2', 'j', '.'));
  eq('0\nb33\n0', cm.getValue());
  (await helpers.doKeys('k', 'v', 'R', '1', '<Esc>'));
  eq('0\n1\n0', cm.getValue());
  (await helpers.doKeys('k', '.'));
  eq('1\n1\n0', cm.getValue());
  (await helpers.doKeys('p'));
  eq('1\n0\n1\n0', cm.getValue());
}, {value: 'a11\na22\nb33\nc44\nc55'}));
(await testVim('mark', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 't'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', 't'));
  helpers.assertCursorAt(2, 2);
  cm.setCursor(2, 0);
  cm.replaceRange('   h', cm.getCursor());
  cm.setCursor(0, 0);
  (await helpers.doKeys('\'', 't'));
  helpers.assertCursorAt(2, 3);
}));
(await testVim('mark\'', async function(cm, vim, helpers) {
  // motions that do not update jumplist
  cm.setCursor(2, 2);
  (await helpers.doKeys('`', '\''));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('j', '3', 'l'));
  (await helpers.doKeys('`', '`'));
  helpers.assertCursorAt(2, 2);
  (await helpers.doKeys('`', '`'));
  helpers.assertCursorAt(1, 3);
  // motions that update jumplist
  (await helpers.doKeys('/', '=', '\n'));
  helpers.assertCursorAt(6, 20);
  (await helpers.doKeys('`', '`'));
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('\'', '\''));
  helpers.assertCursorAt(6, 2);
  (await helpers.doKeys('\'', '`'));
  helpers.assertCursorAt(1, 1);
  // edits
  (await helpers.doKeys('g', 'I', '\n', '<Esc>', 'l'));
  // the column may be different depending on editor behavior in insert mode
  var ch = cm.getCursor().ch;
  (await helpers.doKeys('`', '`'));
  helpers.assertCursorAt(7, 2);
  (await helpers.doKeys('`', '`'));
  helpers.assertCursorAt(2, ch);
}));
(await testVim('mark.', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('O', 'testing', '<Esc>'));
  cm.setCursor(3, 3);
  (await helpers.doKeys('\'', '.'));
  helpers.assertCursorAt(0, 0);
  cm.setCursor(4, 4);
  (await helpers.doKeys('`', '.'));
  helpers.assertCursorAt(0, 6);
}));
(await testVim('jumpToMark_next', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 't'));
  cm.setCursor(0, 0);
  (await helpers.doKeys(']', '`'));
  helpers.assertCursorAt(2, 2);
  cm.setCursor(0, 0);
  (await helpers.doKeys(']', '\''));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('jumpToMark_next_repeat', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(3, 2);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(4, 2);
  (await helpers.doKeys('m', 'c'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('2', ']', '`'));
  helpers.assertCursorAt(3, 2);
  cm.setCursor(0, 0);
  (await helpers.doKeys('2', ']', '\''));
  helpers.assertCursorAt(3, 1);
}));
(await testVim('jumpToMark_next_sameline', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 4);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(2, 2);
  (await helpers.doKeys(']', '`'));
  helpers.assertCursorAt(2, 4);
}));
(await testVim('jumpToMark_next_onlyprev', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(4, 0);
  (await helpers.doKeys(']', '`'));
  helpers.assertCursorAt(4, 0);
}));
(await testVim('jumpToMark_next_nomark', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys(']', '`'));
  helpers.assertCursorAt(2, 2);
  (await helpers.doKeys(']', '\''));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('jumpToMark_next_linewise_over', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(3, 4);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(2, 1);
  (await helpers.doKeys(']', '\''));
  helpers.assertCursorAt(3, 1);
}));
(await testVim('jumpToMark_next_action', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 't'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', ']', '`'));
  helpers.assertCursorAt(0, 0);
  var actual = cm.getLine(0);
  var expected = 'pop pop 0 1 2 3 4';
  eq(actual, expected, "Deleting while jumping to the next mark failed.");
}));
(await testVim('jumpToMark_next_line_action', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 't'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', ']', '\''));
  helpers.assertCursorAt(0, 1);
  var actual = cm.getLine(0);
  var expected = ' (a) [b] {c} '
  eq(actual, expected, "Deleting while jumping to the next mark line failed.");
}));
(await testVim('jumpToMark_prev', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 't'));
  cm.setCursor(4, 0);
  (await helpers.doKeys('[', '`'));
  helpers.assertCursorAt(2, 2);
  cm.setCursor(4, 0);
  (await helpers.doKeys('[', '\''));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('jumpToMark_prev_repeat', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(3, 2);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(4, 2);
  (await helpers.doKeys('m', 'c'));
  cm.setCursor(5, 0);
  (await helpers.doKeys('2', '[', '`'));
  helpers.assertCursorAt(3, 2);
  cm.setCursor(5, 0);
  (await helpers.doKeys('2', '[', '\''));
  helpers.assertCursorAt(3, 1);
}));
(await testVim('jumpToMark_prev_sameline', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 4);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(2, 2);
  (await helpers.doKeys('[', '`'));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('jumpToMark_prev_onlynext', async function(cm, vim, helpers) {
  cm.setCursor(4, 4);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 0);
  (await helpers.doKeys('[', '`'));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('jumpToMark_prev_nomark', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('[', '`'));
  helpers.assertCursorAt(2, 2);
  (await helpers.doKeys('[', '\''));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('jumpToMark_prev_linewise_over', async function(cm, vim, helpers) {
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(3, 4);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(3, 6);
  (await helpers.doKeys('[', '\''));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('delmark_single', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('m', 't'));
  (await helpers.doEx('delmarks t'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', 't'));
  helpers.assertCursorAt(0, 0);
}));
(await testVim('delmark_range', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(3, 2);
  (await helpers.doKeys('m', 'c'));
  cm.setCursor(4, 2);
  (await helpers.doKeys('m', 'd'));
  cm.setCursor(5, 2);
  (await helpers.doKeys('m', 'e'));
  (await helpers.doEx('delmarks b-d'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', 'a'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'b'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'c'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'd'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'e'));
  helpers.assertCursorAt(5, 2);
}));
(await testVim('delmark_multi', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(3, 2);
  (await helpers.doKeys('m', 'c'));
  cm.setCursor(4, 2);
  (await helpers.doKeys('m', 'd'));
  cm.setCursor(5, 2);
  (await helpers.doKeys('m', 'e'));
  (await helpers.doEx('delmarks bcd'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', 'a'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'b'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'c'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'd'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'e'));
  helpers.assertCursorAt(5, 2);
}));
(await testVim('delmark_multi_space', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(3, 2);
  (await helpers.doKeys('m', 'c'));
  cm.setCursor(4, 2);
  (await helpers.doKeys('m', 'd'));
  cm.setCursor(5, 2);
  (await helpers.doKeys('m', 'e'));
  (await helpers.doEx('delmarks b c d'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', 'a'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'b'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'c'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'd'));
  helpers.assertCursorAt(1, 2);
  (await helpers.doKeys('`', 'e'));
  helpers.assertCursorAt(5, 2);
}));
(await testVim('delmark_all', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(2, 2);
  (await helpers.doKeys('m', 'b'));
  cm.setCursor(3, 2);
  (await helpers.doKeys('m', 'c'));
  cm.setCursor(4, 2);
  (await helpers.doKeys('m', 'd'));
  cm.setCursor(5, 2);
  (await helpers.doKeys('m', 'e'));
  (await helpers.doEx('delmarks a b-de'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', 'a'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('`', 'b'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('`', 'c'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('`', 'd'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('`', 'e'));
  helpers.assertCursorAt(0, 0);
}));
(await testVim('visual', async function(cm, vim, helpers) {
  (await helpers.doKeys('l', 'v', 'l', 'l'));
  helpers.assertCursorAt(0, 4);
  eqCursorPos(makeCursor(0, 1), cm.getCursor('anchor'));
  (await helpers.doKeys('d'));
  eq('15', cm.getValue());
}, { value: '12345' }));
(await testVim('visual_yank', async function(cm, vim, helpers) {
  (await helpers.doKeys('v', '3', 'l', 'y'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('p'));
  eq('aa te test for yank', cm.getValue());
}, { value: 'a test for yank' }));
(await testVim('visual_w', async function(cm, vim, helpers) {
  (await helpers.doKeys('v', 'w'));
  eq(cm.getSelection(), 'motion t');
}, { value: 'motion test'}));
(await testVim('visual_initial_selection', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('v'));
  cm.getSelection('n');
}, { value: 'init'}));
(await testVim('visual_crossover_left', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('v', 'l', 'h', 'h'));
  cm.getSelection('ro');
}, { value: 'cross'}));
(await testVim('visual_crossover_left', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('v', 'h', 'l', 'l'));
  cm.getSelection('os');
}, { value: 'cross'}));
(await testVim('visual_crossover_up', async function(cm, vim, helpers) {
  cm.setCursor(3, 2);
  (await helpers.doKeys('v', 'j', 'k', 'k'));
  eqCursorPos(new Pos(2, 2), cm.getCursor('head'));
  eqCursorPos(new Pos(3, 3), cm.getCursor('anchor'));
  (await helpers.doKeys('k'));
  eqCursorPos(new Pos(1, 2), cm.getCursor('head'));
  eqCursorPos(new Pos(3, 3), cm.getCursor('anchor'));
}, { value: 'cross\ncross\ncross\ncross\ncross\n'}));
(await testVim('visual_crossover_down', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('v', 'k', 'j', 'j'));
  eqCursorPos(new Pos(2, 3), cm.getCursor('head'));
  eqCursorPos(new Pos(1, 2), cm.getCursor('anchor'));
  (await helpers.doKeys('j'));
  eqCursorPos(new Pos(3, 3), cm.getCursor('head'));
  eqCursorPos(new Pos(1, 2), cm.getCursor('anchor'));
}, { value: 'cross\ncross\ncross\ncross\ncross\n'}));
(await testVim('visual_exit', async function(cm, vim, helpers) {
  (await helpers.doKeys('<C-v>', 'l', 'j', 'j', '<Esc>'));
  eqCursorPos(cm.getCursor('anchor'), cm.getCursor('head'));
  eq(vim.visualMode, false);
}, { value: 'hello\nworld\nfoo' }));
(await testVim('visual_line', async function(cm, vim, helpers) {
  (await helpers.doKeys('l', 'V', 'l', 'j', 'j', 'd'));
  eq(' 4\n 5', cm.getValue());
}, { value: ' 1\n 2\n 3\n 4\n 5' }));
(await testVim('visual_block_move_to_eol', async function(cm, vim, helpers) {
  // moveToEol should move all block cursors to end of line
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', 'G', '$'));
  var selections = cm.getSelections().join();
  eq('123,45,6', selections);
  // Checks that with cursor at Infinity, finding words backwards still works.
  (await helpers.doKeys('2', 'k', 'b'));
  selections = cm.getSelections().join();
  eq('1', selections);
}, {value: '123\n45\n6'}));
(await testVim('visual_block_different_line_lengths', async function(cm, vim, helpers) {
  // test the block selection with lines of different length
  // i.e. extending the selection
  // till the end of the longest line.
  (await helpers.doKeys('<C-v>', 'l', 'j', 'j', '6', 'l', 'd'));
  (await helpers.doKeys('d', 'd', 'd', 'd'));
  eq('', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));
(await testVim('visual_block_truncate_on_short_line', async function(cm, vim, helpers) {
  // check for left side selection in case
  // of moving up to a shorter line.
  cm.replaceRange('', cm.getCursor());
  cm.setCursor(3, 4);
  (await helpers.doKeys('<C-v>', 'l', 'k', 'k', 'd'));
  eq('hello world\n{\ntis\nsa!', cm.getValue());
}, {value: 'hello world\n{\nthis is\nsparta!'}));
(await testVim('visual_block_corners', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('<C-v>', '2', 'l', 'k'));
  // circle around the anchor
  // and check the selections
  var selections = cm.getSelections();
  eq('345891', selections.join(''));
  (await helpers.doKeys('4', 'h'));
  selections = cm.getSelections();
  eq('123678', selections.join(''));
  (await helpers.doKeys('j', 'j'));
  selections = cm.getSelections();
  eq('678abc', selections.join(''));
  (await helpers.doKeys('4', 'l'));
  selections = cm.getSelections();
  eq('891cde', selections.join(''));
}, {value: '12345\n67891\nabcde'}));
(await testVim('visual_block_mode_switch', async function(cm, vim, helpers) {
  // switch between visual modes
  cm.setCursor(1, 1);
  // blockwise to characterwise visual
  (await helpers.doKeys('<C-v>', 'j', 'l', 'v'));
  var selections = cm.getSelections();
  eq('7891\nabc', selections.join(''));
  // characterwise to blockwise
  (await helpers.doKeys('<C-v>'));
  selections = cm.getSelections();
  eq('78bc', selections.join(''));
  // blockwise to linewise visual
  (await helpers.doKeys('V'));
  selections = cm.getSelections();
  eq('67891\nabcde', selections.join(''));
}, {value: '12345\n67891\nabcde'}));
(await testVim('visual_block_crossing_short_line', async function(cm, vim, helpers) {
  // visual block with long and short lines
  cm.setCursor(0, 3);
  (await helpers.doKeys('<C-v>', 'j', 'j', 'j'));
  var selections = cm.getSelections().join();
  eq('4,,d,b', selections);
  (await helpers.doKeys('3', 'k'));
  selections = cm.getSelections().join();
  eq('4', selections);
  (await helpers.doKeys('5', 'j', 'k'));
  selections = cm.getSelections().join("");
  eq(10, selections.length);
}, {value: '123456\n78\nabcdefg\nfoobar\n}\n'}));
(await testVim('visual_block_curPos_on_exit', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '3' , 'l', '<Esc>'));
  eqCursorPos(makeCursor(0, 3), cm.getCursor());
  (await helpers.doKeys('h', '<C-v>', '2' , 'j' ,'3' , 'l'));
  eq(cm.getSelections().join(), "3456,,cdef");
  (await helpers.doKeys('4' , 'h'));
  eq(cm.getSelections().join(), "23,8,bc");
  (await helpers.doKeys('2' , 'l'));
  eq(cm.getSelections().join(), "34,,cd");
}, {value: '123456\n78\nabcdefg\nfoobar'}));

(await testVim('visual_marks', async function(cm, vim, helpers) {
  (await helpers.doKeys('l', 'v', 'l', 'l', 'j', 'j', 'v'));
  // Test visual mode marks
  cm.setCursor(2, 1);
  (await helpers.doKeys('\'', '<'));
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('\'', '>'));
  helpers.assertCursorAt(2, 0);
}));
(await testVim('visual_join', async function(cm, vim, helpers) {
  (await helpers.doKeys('l', 'V', 'l', 'j', 'j', 'J'));
  eq(' 1 2 3\n 4\n 5', cm.getValue());
  is(!vim.visualMode);
}, { value: ' 1\n 2\n 3\n 4\n 5' }));
(await testVim('visual_join_2', async function(cm, vim, helpers) {
  (await helpers.doKeys('G', 'V', 'g', 'g', 'J'));
  eq('1 2 3 4 5 6', cm.getValue());
  is(!vim.visualMode);
}, { value: '1\n2\n3\n4\n5\n6\n'}));
(await testVim('visual_join_blank', async function(cm, vim, helpers) {
  var initialValue = cm.getValue();
  (await helpers.doKeys('G', 'V', 'g', 'g', 'J'));
  eq('1  2 5 6', cm.getValue());
  is(!vim.visualMode);
  (await helpers.doKeys('u'));
  eq(initialValue, cm.getValue());
  (await helpers.doKeys('G', 'V', 'g', 'g', 'g', 'J'));
  eq('1 \t2\t  5 6', cm.getValue());
  (await helpers.doKeys('u'));
  eq(cm.getCursor().line, 0);
  eq(initialValue, cm.getValue());
  (await helpers.doKeys('J', 'J', 'J'));
  helpers.assertCursorAt(0, 3);
  (await helpers.doKeys('J'));
  helpers.assertCursorAt(0, 4);
  eq('1  2 5\n 6\n', cm.getValue());
  (await helpers.doKeys('u'));
  eq('1  2\n5\n 6\n', cm.getValue());  
}, { value: '1 \n\t2\n\t  \n\n5\n 6\n'}));
(await testVim('visual_blank', async function(cm, vim, helpers) {
  (await helpers.doKeys('v', 'k'));
  eq(vim.visualMode, true);
}, { value: '\n' }));
(await testVim('reselect_visual', async function(cm, vim, helpers) {
  (await helpers.doKeys('l', 'v', 'l', 'l', 'l', 'y', 'g', 'v'));
  helpers.assertCursorAt(0, 5);
  eqCursorPos(makeCursor(0, 1), cm.getCursor('anchor'));
  (await helpers.doKeys('v'));
  cm.setCursor(1, 0);
  (await helpers.doKeys('v', 'l', 'l', 'p'));
  eq('123456\n2345\nbar', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('g', 'v'));
  // here the fake cursor is at (1, 3)
  helpers.assertCursorAt(1, 4);
  eqCursorPos(makeCursor(1, 0), cm.getCursor('anchor'));
  (await helpers.doKeys('v'));
  cm.setCursor(2, 0);
  (await helpers.doKeys('v', 'l', 'l', 'g', 'v'));
  helpers.assertCursorAt(1, 4);
  eqCursorPos(makeCursor(1, 0), cm.getCursor('anchor'));
  (await helpers.doKeys('g', 'v'));
  helpers.assertCursorAt(2, 3);
  eqCursorPos(makeCursor(2, 0), cm.getCursor('anchor'));
  eq('123456\n2345\nbar', cm.getValue());
}, { value: '123456\nfoo\nbar' }));
(await testVim('reselect_visual_line', async function(cm, vim, helpers) {
  (await helpers.doKeys('l', 'V', 'j', 'j', 'V', 'g', 'v', 'd'));
  eq('foo\nand\nbar', cm.getValue());
  cm.setCursor(1, 0);
  (await helpers.doKeys('V', 'y', 'j'));
  (await helpers.doKeys('V', 'p' , 'g', 'v', 'd'));
  eq('foo\nand', cm.getValue());
}, { value: 'hello\nthis\nis\nfoo\nand\nbar' }));
(await testVim('reselect_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(1, 2);
  (await helpers.doKeys('<C-v>', 'k', 'h', '<C-v>'));
  cm.setCursor(2, 1);
  (await helpers.doKeys('v', 'l', 'g', 'v'));
  eqCursorPos(new Pos(1, 2), vim.sel.anchor);
  eqCursorPos(new Pos(0, 1), vim.sel.head);
  // Ensure selection is done with visual block mode rather than one
  // continuous range.
  eq(cm.getSelections().join(''), '23oo');
  (await helpers.doKeys('g', 'v'));
  eqCursorPos(new Pos(2, 1), vim.sel.anchor);
  eqCursorPos(new Pos(2, 2), vim.sel.head);
  (await helpers.doKeys('<Esc>'));
  // Ensure selection of deleted range
  cm.setCursor(1, 1);
  (await helpers.doKeys('v', '<C-v>', 'j', 'd', 'g', 'v'));
  eq(cm.getSelections().join(''), 'or');
}, { value: '123456\nfoo\nbar' }));
(await testVim('s_normal', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('s'));
  (await helpers.doKeys('<Esc>'));
  eq('ac', cm.getValue());
}, { value: 'abc'}));
(await testVim('s_normal surrogate character', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('s'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  eq('test', cm.getValue());
}, { value: '😀' }));
(await testVim('s_visual', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('v', 's'));
  (await helpers.doKeys('<Esc>'));
  helpers.assertCursorAt(0, 0);
  eq('ac', cm.getValue());
}, { value: 'abc'}));
(await testVim('d with surrogate character', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('v'));
  (await helpers.doKeys('d'));
  (await helpers.doKeys('<Esc>'));
  eq('', cm.getValue());
}, { value: '😀' }));
(await testVim('o_visual', async function(cm, vim, helpers) {
  cm.setCursor(0,0);
  (await helpers.doKeys('v','l','l','l','o'));
  helpers.assertCursorAt(0,0);
  (await helpers.doKeys('v','v','j','j','j','o'));
  helpers.assertCursorAt(0,0);
  (await helpers.doKeys('O'));
  (await helpers.doKeys('l','l'));
  helpers.assertCursorAt(3, 3);
  (await helpers.doKeys('d'));
  eq('p',cm.getValue());
}, { value: 'abcd\nefgh\nijkl\nmnop'}));
(await testVim('o_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>','3','j','l','l', 'o'));
  eqCursorPos(new Pos(3, 3), vim.sel.anchor);
  eqCursorPos(new Pos(0, 1), vim.sel.head);
  (await helpers.doKeys('O'));
  eqCursorPos(new Pos(3, 1), vim.sel.anchor);
  eqCursorPos(new Pos(0, 3), vim.sel.head);
  (await helpers.doKeys('o'));
  eqCursorPos(new Pos(0, 3), vim.sel.anchor);
  eqCursorPos(new Pos(3, 1), vim.sel.head);
}, { value: 'abcd\nefgh\nijkl\nmnop'}));
(await testVim('changeCase_visual', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'l', 'l'));
  (await helpers.doKeys('U'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('v', 'l', 'l'));
  (await helpers.doKeys('u'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('l', 'l', 'l', '.'));
  helpers.assertCursorAt(0, 3);
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', 'v', 'j', 'U', 'q'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('j', '@', 'a'));
  helpers.assertCursorAt(1, 0);
  cm.setCursor(3, 0);
  (await helpers.doKeys('V', 'U', 'j', '.'));
  eq('ABCDEF\nGHIJKL\nMnopq\nSHORT LINE\nLONG LINE OF TEXT', cm.getValue());
}, { value: 'abcdef\nghijkl\nmnopq\nshort line\nlong line of text'}));
(await testVim('changeCase_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(2, 1);
  (await helpers.doKeys('<C-v>', 'k', 'k', 'h', 'U'));
  eq('ABcdef\nGHijkl\nMNopq\nfoo', cm.getValue());
  cm.setCursor(0, 2);
  (await helpers.doKeys('.'));
  eq('ABCDef\nGHIJkl\nMNOPq\nfoo', cm.getValue());
  // check when last line is shorter.
  cm.setCursor(2, 2);
  (await helpers.doKeys('.'));
  eq('ABCDef\nGHIJkl\nMNOPq\nfoO', cm.getValue());
}, { value: 'abcdef\nghijkl\nmnopq\nfoo'}));
(await testVim('visual_paste', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'l', 'l', 'y'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('3', 'l', 'j', 'v', 'l', 'p'));
  helpers.assertCursorAt(1, 5);
  eq('this is a\nunithitest for visual paste', cm.getValue());
  cm.setCursor(0, 0);
  // in case of pasting whole line
  (await helpers.doKeys('y', 'y'));
  cm.setCursor(1, 6);
  (await helpers.doKeys('v', 'l', 'l', 'l', 'p'));
  helpers.assertCursorAt(2, 0);
  eq('this is a\nunithi\nthis is a\n for visual paste', cm.getValue());
}, { value: 'this is a\nunit test for visual paste'}));

// This checks the contents of the register used to paste the text
(await testVim('v_paste_from_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('"', 'a', 'y', 'w'));
  cm.setCursor(1, 0);
  (await helpers.doKeys('v', 'p'));
  (await helpers.doEx('registers'));
  is(/a\s+register/.test(helpers.getNotificationText()));
}, { value: 'register contents\nare not erased'}));
(await testVim('S_normal', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('j', 'S'));
  (await helpers.doKeys('<Esc>'));
  helpers.assertCursorAt(1, 1);
  eq('aa{\n  \ncc', cm.getValue());
  (await helpers.doKeys('j', 'S'));
  eq('aa{\n  \n', cm.getValue());
  helpers.assertCursorAt(2, 0);
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('d', 'd', 'd', 'd'));
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('S'));
  is(vim.insertMode);
  eq('', cm.getValue());
}, { value: 'aa{\n  bb\ncc'}));
(await testVim('blockwise_paste', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '3', 'j', 'l', 'y'));
  cm.setCursor(0, 2);
  // paste one char after the current cursor position
  (await helpers.doKeys('p'));
  eq('helhelo\nworwold\nfoofo\nbarba', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', '4', 'l', 'y'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '3', 'j', 'p'));
  eq('helheelhelo\norwold\noofo\narba', cm.getValue());
}, { value: 'hello\nworld\nfoo\nbar'}));
(await testVim('blockwise_paste_long/short_line', async function(cm, vim, helpers) {
  // extend short lines in case of different line lengths.
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', 'j', 'j', 'y'));
  cm.setCursor(0, 3);
  (await helpers.doKeys('p'));
  eq('hellho\nfoo f\nbar b', cm.getValue());
}, { value: 'hello\nfoo\nbar'}));
(await testVim('blockwise_paste_cut_paste', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '2', 'j', 'x'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('P'));
  eq('cut\nand\npaste\nme', cm.getValue());
}, { value: 'cut\nand\npaste\nme'}));
(await testVim('blockwise_paste_from_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '2', 'j', '"', 'a', 'y'));
  cm.setCursor(0, 3);
  (await helpers.doKeys('"', 'a', 'p'));
  eq('foobfar\nhellho\nworlwd', cm.getValue());
}, { value: 'foobar\nhello\nworld'}));
(await testVim('blockwise_paste_last_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'y'));
  cm.setCursor(3, 0);
  (await helpers.doKeys('p'));
  eq('cut\nand\npaste\nmcue\n an\n pa', cm.getValue());
}, { value: 'cut\nand\npaste\nme'}));

(await testVim('S_visual', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('v', 'j', 'S'));
  (await helpers.doKeys('<Esc>'));
  helpers.assertCursorAt(0, 0);
  eq('\ncc', cm.getValue());
}, { value: 'aa\nbb\ncc'}));

(await testVim('d_/', async function(cm, vim, helpers) {
  (await helpers.doKeys('2', 'd', '/', 'match', '\n'));
  helpers.assertCursorAt(0, 0);
  eq('match \n next', cm.getValue());
  (await helpers.doKeys('d', ':', '2', '\n'));
  // TODO eq(' next', cm.getValue());
}, { value: 'text match match \n next' }));
(await testVim('/ and n/N', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'match', '\n'));
  helpers.assertCursorAt(0, 11);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 6);
  (await helpers.doKeys('N'));
  helpers.assertCursorAt(0, 11);

  cm.setCursor(0, 0);
  (await helpers.doKeys('2', '/', 'match', '\n'));
  helpers.assertCursorAt(1, 6);
}, { value: 'match nope match \n nope Match' }));
(await testVim('/ and gn selects the appropriate word', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'match', '\n'));
  helpers.assertCursorAt(0, 11);

  // gn should highlight the the current word while it is within a match.

  // gn when cursor is in beginning of match
  (await helpers.doKeys('gn', '<Esc>'));
  helpers.assertCursorAt(0, 15);

  // gn when cursor is at end of match
  (await helpers.doKeys('gn', '<Esc>'));
  (await helpers.doKeys('<Esc>'));
  helpers.assertCursorAt(0, 15);

  // consecutive gns should extend the selection
  (await helpers.doKeys('gn'));
  helpers.assertCursorAt(0, 16);
  (await helpers.doKeys('gn'));
  helpers.assertCursorAt(1, 11);

  // we should have selected the second and third "match"
  (await helpers.doKeys('d'));
  eq('match nope ', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('/ and gN selects the appropriate word', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'match', '\n'));
  helpers.assertCursorAt(0, 11);

  // gN when cursor is at beginning of match
  (await helpers.doKeys('gN', '<Esc>'));
  helpers.assertCursorAt(0, 11);

  // gN when cursor is at end of match
  (await helpers.doKeys('e', 'gN', '<Esc>'));
  helpers.assertCursorAt(0, 11);

  // consecutive gNs should extend the selection
  (await helpers.doKeys('gN'));
  helpers.assertCursorAt(0, 11);
  (await helpers.doKeys('gN'));
  helpers.assertCursorAt(0, 0);

  // we should have selected the first and second "match"
  (await helpers.doKeys('d'));
  eq(' \n nope Match', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('/ and gn with an associated operator', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'match', '\n'));
  helpers.assertCursorAt(0, 11);

  (await helpers.doKeys('c', 'gn', 'changed', '<Esc>'));

  // change the current match.
  eq('match nope changed \n nope Match', cm.getValue());

  // change the next match.
  (await helpers.doKeys('.'));
  eq('match nope changed \n nope changed', cm.getValue());

  // change the final match.
  (await helpers.doKeys('.'));
  eq('changed nope changed \n nope changed', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('/ and gN with an associated operator', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'match', '\n'));
  helpers.assertCursorAt(0, 11);

  (await helpers.doKeys('c', 'gN', 'changed', '<Esc>'));

  // change the current match.
  eq('match nope changed \n nope Match', cm.getValue());

  // change the next match.
  (await helpers.doKeys('.'));
  eq('changed nope changed \n nope Match', cm.getValue());

  // change the final match.
  (await helpers.doKeys('.'));
  eq('changed nope changed \n nope changed', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('/_case', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'Match', '\n'));
  helpers.assertCursorAt(1, 6);
}, { value: 'match nope match \n nope Match' }));
(await testVim('/_2_pcre', async function(cm, vim, helpers) {
  CodeMirror.Vim.setOption('pcre', true);
  (await helpers.doKeys('/', '(word){2}', '\n'));
  helpers.assertCursorAt(1, 9);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(2, 1);
}, { value: 'word\n another wordword\n wordwordword\n' }));
(await testVim('/_2_nopcre', async function(cm, vim, helpers) {
  CodeMirror.Vim.setOption('pcre', false);
  (await helpers.doKeys('/', '\\(word\\)\\{2}', '\n'));
  helpers.assertCursorAt(1, 9);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(2, 1);
}, { value: 'word\n another wordword\n wordwordword\n' }));
(await testVim('/_nongreedy', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'aa', '\n'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 0);
}, { value: 'aaa aa \n a aa'}));
(await testVim('?_nongreedy', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'aa', '\n'));
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, isOldCodeMirror ? 1 : 0);
}, { value: 'aaa aa \n a aa'}));
(await testVim('/_greedy', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'a+', '\n'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 1);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 0);
}, { value: 'aaa aa \n a aa'}));
(await testVim('?_greedy', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'a+', '\n'));
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 1);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 0);
}, { value: 'aaa aa \n a aa'}));
(await testVim('/_greedy_0_or_more', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'a*', '\n'));
  helpers.assertCursorAt(0, 3);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 5);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 0);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 1);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 0);
}, { value: 'aaa  aa\n aa'}));
(await testVim('?_greedy_0_or_more', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'a*', '\n'));
  helpers.assertCursorAt(1, 1);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(1, 0);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 5);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 0);
}, { value: 'aaa  aa\n aa'}));
(await testVim('? and n/N', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'match', '\n'));
  helpers.assertCursorAt(1, 6);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 11);
  (await helpers.doKeys('N'));
  helpers.assertCursorAt(1, 6);

  cm.setCursor(0, 0);
  (await helpers.doKeys('2', '?', 'match', '\n'));
  helpers.assertCursorAt(0, 11);
}, { value: 'match nope match \n nope Match' }));
(await testVim('? and gn selects the appropriate word', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'match', '\n', 'n'));
  helpers.assertCursorAt(0, 11);

  // gn should highlight the the current word while it is within a match.

  // gn when cursor is in beginning of match
  (await helpers.doKeys('gn', '<Esc>'));
  helpers.assertCursorAt(0, 11);

  // gn when cursor is at end of match
  (await helpers.doKeys('e', 'gn', '<Esc>'));
  helpers.assertCursorAt(0, 11);

  // consecutive gns should extend the selection
  (await helpers.doKeys('gn'));
  helpers.assertCursorAt(0, 11);
  (await helpers.doKeys('gn'));
  helpers.assertCursorAt(0, 0);

  // we should have selected the first and second "match"
  (await helpers.doKeys('d'));
  eq(' \n nope Match', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('? and gN selects the appropriate word', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'match', '\n', 'n'));
  helpers.assertCursorAt(0, 11);

  // gN when cursor is at beginning of match
  (await helpers.doKeys('gN', '<Esc>'));
  helpers.assertCursorAt(0, 15);

  // gN when cursor is at end of match
  (await helpers.doKeys('gN', '<Esc>'));
  helpers.assertCursorAt(0, 15);

  // consecutive gNs should extend the selection
  (await helpers.doKeys('gN'));
  helpers.assertCursorAt(0, 16);
  (await helpers.doKeys('gN'));
  helpers.assertCursorAt(1, 11);

  // we should have selected the second and third "match"
  (await helpers.doKeys('d'));
  eq('match nope ', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('? and gn with an associated operator', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'match', '\n', 'n'));
  helpers.assertCursorAt(0, 11);

  (await helpers.doKeys('c', 'gn', 'changed', '<Esc>'));

  // change the current match.
  eq('match nope changed \n nope Match', cm.getValue());

  // change the next match.
  (await helpers.doKeys('.'));
  eq('changed nope changed \n nope Match', cm.getValue());

  // change the final match.
  (await helpers.doKeys('.'));
  eq('changed nope changed \n nope changed', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('? and gN with an associated operator', async function(cm, vim, helpers) {
  (await helpers.doKeys('?', 'match', '\n', 'n'));
  helpers.assertCursorAt(0, 11);

  (await helpers.doKeys('c', 'gN', 'changed', '<Esc>'));

  // change the current match.
  eq('match nope changed \n nope Match', cm.getValue());

  // change the next match.
  (await helpers.doKeys('.'));
  eq('match nope changed \n nope changed', cm.getValue());

  // change the final match.
  (await helpers.doKeys('.'));
  eq('changed nope changed \n nope changed', cm.getValue());
}, { value: 'match nope match \n nope Match' }));
(await testVim('*', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('*'));
  helpers.assertCursorAt(0, 22);

  cm.setCursor(0, 9);
  (await helpers.doKeys('2', '*'));
  helpers.assertCursorAt(1, 8);
}, { value: 'nomatch match nomatch match \nnomatch Match' }));
(await testVim('*_no_word', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('*'));
  helpers.assertCursorAt(0, 0);
}, { value: ' \n match \n' }));
(await testVim('*_symbol', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('*'));
  helpers.assertCursorAt(1, 0);
}, { value: ' /}\n/} match \n' }));
(await testVim('#', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('#'));
  helpers.assertCursorAt(1, 8);

  cm.setCursor(0, 9);
  (await helpers.doKeys('2', '#'));
  helpers.assertCursorAt(0, 22);
}, { value: 'nomatch match nomatch match \nnomatch Match' }));
(await testVim('*_seek', async function(cm, vim, helpers) {
  // Should skip over space and symbols.
  cm.setCursor(0, 3);
  (await helpers.doKeys('*'));
  helpers.assertCursorAt(0, 22);
}, { value: '    :=  match nomatch match \nnomatch Match' }));
(await testVim('#', async function(cm, vim, helpers) {
  // Should skip over space and symbols.
  cm.setCursor(0, 3);
  (await helpers.doKeys('#'));
  helpers.assertCursorAt(1, 8);
}, { value: '    :=  match nomatch match \nnomatch Match' }));
(await testVim('g*', async function(cm, vim, helpers) {
  cm.setCursor(0, 8);
  (await helpers.doKeys('g', '*'));
  helpers.assertCursorAt(0, 18);
  cm.setCursor(0, 8);
  (await helpers.doKeys('3', 'g', '*'));
  helpers.assertCursorAt(1, 8);
}, { value: 'matches match alsoMatch\nmatchme matching' }));
(await testVim('g#', async function(cm, vim, helpers) {
  cm.setCursor(0, 8);
  (await helpers.doKeys('g', '#'));
  helpers.assertCursorAt(0, 0);
  cm.setCursor(0, 8);
  (await helpers.doKeys('3', 'g', '#'));
  helpers.assertCursorAt(1, 0);
}, { value: 'matches match alsoMatch\nmatchme matching' }));
(await testVim('macro_insert', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', '0', 'i'));
  (await helpers.doKeys('foo'));
  (await helpers.doKeys('<Esc>'));
  eq(helpers.getNotificationText(), 'recording @a');
  (await helpers.doKeys('q', '@', 'a'));
  eq(helpers.getNotificationText(), null);
  eq('foofoo', cm.getValue());
}, { value: ''}));
(await testVim('macro_insert_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', '$', 'a'));
  (await helpers.doKeys('larry.'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('a'));
  (await helpers.doKeys('curly.'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('q'));
  (await helpers.doKeys('a'));
  (await helpers.doKeys('moe.'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('@', 'a'));
  // At this point, the most recent edit should be the 2nd insert change
  // inside the macro, i.e. "curly.".
  (await helpers.doKeys('.'));
  eq('larry.curly.moe.larry.curly.curly.', cm.getValue());
}, { value: ''}));
(await testVim('macro_space', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('<Space>', '<Space>'));
  helpers.assertCursorAt(0, 2);
  (await helpers.doKeys('q', 'a', '<Space>', '<Space>', 'q'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('@', 'a'));
  helpers.assertCursorAt(0, 6);
  (await helpers.doKeys('@', 'a'));
  helpers.assertCursorAt(0, 8);
}, { value: 'one line of text.'}));
(await testVim('macro_t_search', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', 't', 'e', 'q'));
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('l', '@', 'a'));
  helpers.assertCursorAt(0, 6);
  (await helpers.doKeys('l', ';'));
  helpers.assertCursorAt(0, 12);
}, { value: 'one line of text.'}));
(await testVim('macro_f_search', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'b', 'f', 'e', 'q'));
  helpers.assertCursorAt(0, 2);
  (await helpers.doKeys('@', 'b'));
  helpers.assertCursorAt(0, 7);
  (await helpers.doKeys(';'));
  helpers.assertCursorAt(0, 13);
}, { value: 'one line of text.'}));
(await testVim('macro_slash_search', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'c'));
  (await helpers.doKeys('/', 'e', '\n', 'q'));
  helpers.assertCursorAt(0, 2);
  (await helpers.doKeys('@', 'c'));
  helpers.assertCursorAt(0, 7);
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 13);
}, { value: 'one line of text.'}));
(await testVim('macro_multislash_search', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'd'));
  (await helpers.doKeys('/', 'e', '\n'));
  (await helpers.doKeys('/', 't', '\n', 'q'));
  helpers.assertCursorAt(0, 12);
  (await helpers.doKeys('@', 'd'));
  helpers.assertCursorAt(0, 15);
}, { value: 'one line of text to rule them all.'}));
(await testVim('macro_last_ex_command_register', async function (cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('s/a/b'));
  (await helpers.doKeys('2', '@', ':'));
  eq('bbbaa', cm.getValue());
  helpers.assertCursorAt(0, 2);
}, { value: 'aaaaa'}));
(await testVim('macro_last_run_macro', async function (cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', 'C', 'a', '<Esc>', 'q'));
  (await helpers.doKeys('q', 'b', 'C', 'b', '<Esc>', 'q'));
  (await helpers.doKeys('@', 'a'));
  (await helpers.doKeys('d', 'd'));
  (await helpers.doKeys('@', '@'));
  eq('a', cm.getValue());
}, { value: ''}));
(await testVim('macro_parens', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'z', 'i'));
  (await helpers.doKeys('('));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('e', 'a'));
  (await helpers.doKeys(')'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('q'));
  (await helpers.doKeys('w', '@', 'z'));
  (await helpers.doKeys('w', '@', 'z'));
  eq('(see) (spot) (run)', cm.getValue());
}, { value: 'see spot run'}));
(await testVim('macro_overwrite', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'z', '0', 'i'));
  (await helpers.doKeys('I '));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('q'));
  (await helpers.doKeys('e'));
  // Now replace the macro with something else.
  (await helpers.doKeys('q', 'z', 'a'));
  (await helpers.doKeys('.'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('q'));
  (await helpers.doKeys('e', '@', 'z'));
  (await helpers.doKeys('e', '@', 'z'));
  eq('I see. spot. run.', cm.getValue());
}, { value: 'see spot run'}));
(await testVim('macro_search_f', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', 'f', ' '));
  helpers.assertCursorAt(0,3);
  (await helpers.doKeys('q', '0'));
  helpers.assertCursorAt(0,0);
  (await helpers.doKeys('@', 'a'));
  helpers.assertCursorAt(0,3);
}, { value: 'The quick brown fox jumped over the lazy dog.'}));
(await testVim('macro_search_2f', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', '2', 'f', ' '));
  helpers.assertCursorAt(0,9);
  (await helpers.doKeys('q', '0'));
  helpers.assertCursorAt(0,0);
  (await helpers.doKeys('@', 'a'));
  helpers.assertCursorAt(0,9);
}, { value: 'The quick brown fox jumped over the lazy dog.'}));
(await testVim('macro_yank_tick', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  // Start recording a macro into the \' register.
  (await helpers.doKeys('q', '\''));
  (await helpers.doKeys('y', '<Right>', '<Right>', '<Right>', '<Right>', 'p'));
  helpers.assertCursorAt(0,4);
  eq('the tex parrot', cm.getValue());
}, { value: 'the ex parrot'}));
(await testVim('yank_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('"', 'a', 'y', 'y'));
  (await helpers.doKeys('j', '"', 'b', 'y', 'y'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/a\s+foo/.test(text));
  is(/b\s+bar/.test(text));
}, { value: 'foo\nbar'}));
(await testVim('yank_visual_block', async function(cm, vim, helpers) {
  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', 'l', 'j', '"', 'a', 'y'));
  (await helpers.doEx('registers'));
  is(/a\s+oo\nar/.test(helpers.getNotificationText()));
}, { value: 'foo\nbar'}));
(await testVim('yank_append_line_to_line_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('"', 'a', 'y', 'y'));
  (await helpers.doKeys('j', '"', 'A', 'y', 'y'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/a\s+foo\nbar/.test(text));
  is(/"\s+foo\nbar/.test(text));
}, { value: 'foo\nbar'}));
(await testVim('yank_append_word_to_word_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('"', 'a', 'y', 'w'));
  (await helpers.doKeys('j', '"', 'A', 'y', 'w'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/a\s+foobar/.test(text));
  is(/"\s+foobar/.test(text));
}, { value: 'foo\nbar'}));
(await testVim('yank_append_line_to_word_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('"', 'a', 'y', 'w'));
  (await helpers.doKeys('j', '"', 'A', 'y', 'y'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/a\s+foo\nbar/.test(text));
  is(/"\s+foo\nbar/.test(text));
}, { value: 'foo\nbar'}));
(await testVim('yank_append_word_to_line_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('"', 'a', 'y', 'y'));
  (await helpers.doKeys('j', '"', 'A', 'y', 'w'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/a\s+foo\nbar/.test(text));
  is(/"\s+foo\nbar/.test(text));
}, { value: 'foo\nbar'}));
(await testVim('black_hole_register', async function(cm,vim,helpers) {
  (await helpers.doKeys('g', 'g', 'y', 'G'));
  (await helpers.doEx('registers'));
  var registersText = helpers.getNotificationText();
  (await helpers.doKeys('"', '_', 'd', 'G'));
  (await helpers.doEx('registers'));
  eq(registersText, helpers.getNotificationText(), 'One or more registers were modified');
  (await helpers.doKeys('"', '_', 'p'));
  eq('', cm.getValue());
}, { value: 'foo\nbar'}));
(await testVim('macro_register', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('q', 'a', 'i'));
  (await helpers.doKeys('gangnam'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('q'));
  (await helpers.doKeys('q', 'b', 'o'));
  (await helpers.doKeys('style'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('q'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/a\s+i/.test(text));
  is(/b\s+o/.test(text));
}, { value: ''}));
(await testVim('._register', async function(cm,vim,helpers) {
  cm.setCursor(0,0);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('foo'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doEx('registers'));
  is(/\.\s+foo/.test(helpers.getNotificationText()));
}, {value: ''}));
(await testVim(':_register', async function(cm,vim,helpers) {
  (await helpers.doEx('bar'));
  (await helpers.doEx('registers'));
  is(/:\s+bar/.test(helpers.getNotificationText()));
}, {value: ''}));
(await testVim('registers_html_encoding', async function(cm,vim,helpers) {
  (await helpers.doKeys('y', 'y'));
  (await helpers.doEx('registers'));
  is(/"\s+<script>throw "&amp;"<\/script>/.test(helpers.getNotificationText()));
}, {value: '<script>throw "&amp;"</script>'}));
(await testVim('search_register_escape', async function(cm, vim, helpers) {
  // Check that the register is restored if the user escapes rather than confirms.
  (await helpers.doKeys('/', 'waldo', '\n'));
  (await helpers.doKeys('/', 'foo', '<Esc>'));
  (await helpers.doEx('registers'));
  var text = helpers.getNotificationText();
  is(/waldo/.test(text));
  is(!/foo/.test(text));
}, {value: ''}));
(await testVim('search_register', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'foo', '\n'));
  (await helpers.doEx('registers'));
  is(/\/\s+foo/.test(helpers.getNotificationText()));
}, {value: ''}));
(await testVim('search_history', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'this', '\n'));
  (await helpers.doKeys('/', 'checks', '\n'));
  (await helpers.doKeys('/', 'search', '\n'));
  (await helpers.doKeys('/', 'history', '\n'));
  (await helpers.doKeys('/', 'checks', '\n'));
  (await helpers.doKeys('/'));
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'checks');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'history');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'search');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'this');
  (await helpers.doKeys('Down'));
  eq(document.activeElement.value, 'search');
}, {value: ''}));
(await testVim('exCommand_history', async function(cm, vim, helpers) {
  (await helpers.doEx('registers'));
  (await helpers.doEx('sort'));
  (await helpers.doEx('map'));
  (await helpers.doEx('invalid'));
  (await helpers.doKeys(':'));
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'invalid');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'map');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'sort');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'registers');
  (await helpers.doKeys('<Esc>', ':'));
  (await helpers.doKeys('s'));
  eq(document.activeElement.value, 's');
  (await helpers.doKeys('Up'));
  eq(document.activeElement.value, 'sort');
}, {value: ''}));
(await testVim('search_clear', async function(cm, vim, helpers) {
  (await helpers.doKeys('/', 'foo'));
  eq(document.activeElement.value, 'foo');
  (await helpers.doKeys('<C-u>'));
  eq(document.activeElement.value, '');
}));
(await testVim('exCommand_clear', async function(cm, vim, helpers) {
  (await helpers.doKeys(':', 'foo'));
  eq(document.activeElement.value, 'foo');
  (await helpers.doKeys('<C-u>'));
  eq(document.activeElement.value, '');
}));
(await testVim('._normal', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('2', 'd', 'w'));
  (await helpers.doKeys('.'));
  eq('5 6', cm.getValue());

  (await helpers.doKeys('a'));
  cm.operation(function() {
    cm.curOp.isVimOp = true;
    cm.replaceSelection("()");
    var pos = cm.getCursor();
    pos.ch--;
    cm.setCursor(pos);
  });
  (await helpers.doKeys('x', 'y', '<Esc>'));
  (await helpers.doKeys('.'));
  eq('5(xy(xy)) 6', cm.getValue());
}, { value: '1 2 3 4 5 6'}));
(await testVim('._repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('2', 'd', 'w'));
  (await helpers.doKeys('3', '.'));
  eq('6', cm.getValue());
}, { value: '1 2 3 4 5 6'}));
(await testVim('._insert', async function(cm, vim, helpers) {
  (await helpers.doKeys('i'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('.'));
  eq('testestt', cm.getValue());
  helpers.assertCursorAt(0, 6);
  (await helpers.doKeys('O'));
  (await helpers.doKeys('xyz'));
  (await helpers.doKeys('Backspace'));
  (await helpers.doKeys('Down'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('.'));
  eq('xy\nxy\ntestestt', cm.getValue());
  helpers.assertCursorAt(1, 1);
}, { value: ''}));
(await testVim('._startinsert', async function(cm, vim, helpers) {
  (await helpers.doEx('map i x'));
  (await helpers.doKeys('i'));
  eq('', cm.getValue());
  (await helpers.doEx('start'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('.'));
  eq('testestt', cm.getValue());
  helpers.assertCursorAt(0, 6);
  (await helpers.doEx('start!'));
  (await helpers.doKeys('xyz'));
  eq('testesttxyz', cm.getValue());
  helpers.assertCursorAt(0, 11);
}, { value: 'x'}));
(await testVim('._insert_repeat', async function(cm, vim, helpers) {
  (await helpers.doKeys('i'));
  (await helpers.doKeys('test'));
  cm.setCursor(0, 4);
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('2', '.'));
  eq('testesttestt', cm.getValue());
  helpers.assertCursorAt(0, 10);
}, { value: ''}));
(await testVim('._repeat_insert', async function(cm, vim, helpers) {
  (await helpers.doKeys('3', 'i'));
  (await helpers.doKeys('te'));
  cm.setCursor(0, 2);
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('.'));
  eq('tetettetetee', cm.getValue());
  helpers.assertCursorAt(0, 10);
}, { value: ''}));
(await testVim('._insert_o', async function(cm, vim, helpers) {
  (await helpers.doKeys('o'));
  (await helpers.doKeys('z'));
  cm.setCursor(1, 1);
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('.'));
  eq('\nz\nz', cm.getValue());
  helpers.assertCursorAt(2, 0);
}, { value: ''}));
(await testVim('._insert_o_repeat', async function(cm, vim, helpers) {
  (await helpers.doKeys('o'));
  (await helpers.doKeys('z'));
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(1, 0);
  (await helpers.doKeys('2', '.'));
  eq('\nz\nz\nz', cm.getValue());
  helpers.assertCursorAt(3, 0);
}, { value: ''}));
(await testVim('._insert_o_indent', async function(cm, vim, helpers) {
  (await helpers.doKeys('o'));
  (await helpers.doKeys('z'));
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(1, 2);
  (await helpers.doKeys('.'));
  eq('{\n  z\n  z', cm.getValue());
  helpers.assertCursorAt(2, 2);
}, { value: '{'}));
(await testVim('._insert_cw', async function(cm, vim, helpers) {
  (await helpers.doKeys('c', 'w'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(0, 3);
  (await helpers.doKeys('2', 'l'));
  (await helpers.doKeys('.'));
  eq('test test word3', cm.getValue());
  helpers.assertCursorAt(0, 8);
}, { value: 'word1 word2 word3' }));
(await testVim('._insert_cw_repeat', async function(cm, vim, helpers) {
  // For some reason, repeat cw in desktop VIM will does not repeat insert mode
  // changes. Will conform to that behavior.
  (await helpers.doKeys('c', 'w'));
  (await helpers.doKeys('test'));
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(0, 4);
  (await helpers.doKeys('l'));
  (await helpers.doKeys('2', '.'));
  eq('test test', cm.getValue());
  helpers.assertCursorAt(0, 8);
}, { value: 'word1 word2 word3' }));
(await testVim('._delete', async function(cm, vim, helpers) {
  cm.setCursor(0, 5);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('Backspace'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('.'));
  eq('zace', cm.getValue());
  helpers.assertCursorAt(0, 1);
}, { value: 'zabcde'}));
(await testVim('._delete_repeat', async function(cm, vim, helpers) {
  cm.setCursor(0, 6);
  (await helpers.doKeys('i'));
  (await helpers.doKeys('Backspace'));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('2', '.'));
  eq('zzce', cm.getValue());
  helpers.assertCursorAt(0, 1);
}, { value: 'zzabcde'}));
(await testVim('._visual_>', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('V', 'j', '>'));
  cm.setCursor(2, 0);
  (await helpers.doKeys('.'));
  eq('  1\n  2\n  3\n  4', cm.getValue());
  helpers.assertCursorAt(2, 2);
}, { value: '1\n2\n3\n4'}));
(await testVim('._replace_repeat', async function(cm, vim, helpers) {
  (await helpers.doKeys('R'));
  cm.replaceRange('123', cm.getCursor(), offsetCursor(cm.getCursor(), 0, 3));
  cm.setCursor(0, 3);
  (await helpers.doKeys('<Esc>'));
  (await helpers.doKeys('2', '.'));
  eq('12123123\nabcdefg', cm.getValue());
  helpers.assertCursorAt(0, 7);
  cm.setCursor(1, 0);
  (await helpers.doKeys('.'));
  eq('12123123\n123123g', cm.getValue());
  (await helpers.doKeys('l', '"', '.', 'p'));
  eq('12123123\n123123g123', cm.getValue());
}, { value: 'abcdef\nabcdefg'}));
(await testVim('f;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('f', 'x'));
  (await helpers.doKeys(';'));
  (await helpers.doKeys('2', ';'));
  eq(9, cm.getCursor().ch);
}, { value: '01x3xx678x'}));
(await testVim('F;', async function(cm, vim, helpers) {
  cm.setCursor(0, 8);
  (await helpers.doKeys('F', 'x'));
  (await helpers.doKeys(';'));
  (await helpers.doKeys('2', ';'));
  eq(2, cm.getCursor().ch);
}, { value: '01x3xx6x8x'}));
(await testVim('t;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('t', 'x'));
  (await helpers.doKeys(';'));
  (await helpers.doKeys('2', ';'));
  eq(8, cm.getCursor().ch);
}, { value: '01x3xx678x'}));
(await testVim('T;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('T', 'x'));
  (await helpers.doKeys(';'));
  (await helpers.doKeys('2', ';'));
  eq(2, cm.getCursor().ch);
}, { value: '0xx3xx678x'}));
(await testVim('f,', async function(cm, vim, helpers) {
  cm.setCursor(0, 6);
  (await helpers.doKeys('f', 'x'));
  (await helpers.doKeys(','));
  (await helpers.doKeys('2', ','));
  eq(2, cm.getCursor().ch);
}, { value: '01x3xx678x'}));
(await testVim('F,', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doKeys('F', 'x'));
  (await helpers.doKeys(','));
  (await helpers.doKeys('2', ','));
  eq(9, cm.getCursor().ch);
}, { value: '01x3xx678x'}));
(await testVim('t,', async function(cm, vim, helpers) {
  cm.setCursor(0, 6);
  (await helpers.doKeys('t', 'x'));
  (await helpers.doKeys(','));
  (await helpers.doKeys('2', ','));
  eq(3, cm.getCursor().ch);
}, { value: '01x3xx678x'}));
(await testVim('T,', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('T', 'x'));
  (await helpers.doKeys(','));
  (await helpers.doKeys('2', ','));
  eq(8, cm.getCursor().ch);
}, { value: '01x3xx67xx'}));
(await testVim('fd,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('f', '4'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', ';'));
  eq('56789', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('d', ','));
  eq('01239', cm.getValue());
}, { value: '0123456789'}));
(await testVim('Fd,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('F', '4'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('d', ';'));
  eq('01239', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', ','));
  eq('56789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('td,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('t', '4'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', ';'));
  eq('456789', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('d', ','));
  eq('012349', cm.getValue());
}, { value: '0123456789'}));
(await testVim('Td,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('T', '4'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('d', ';'));
  eq('012349', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('d', ','));
  eq('456789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('fc,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('f', '4'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('c', ';', '<Esc>'));
  eq('56789', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('c', ','));
  eq('01239', cm.getValue());
}, { value: '0123456789'}));
(await testVim('Fc,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('F', '4'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('c', ';', '<Esc>'));
  eq('01239', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('c', ','));
  eq('56789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('tc,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('t', '4'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('c', ';', '<Esc>'));
  eq('456789', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('c', ','));
  eq('012349', cm.getValue());
}, { value: '0123456789'}));
(await testVim('Tc,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('T', '4'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('c', ';', '<Esc>'));
  eq('012349', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('c', ','));
  eq('456789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('fy,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('f', '4'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('y', ';', 'P'));
  eq('012340123456789', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('y', ',', 'P'));
  eq('012345678456789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('Fy,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('F', '4'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('y', ';', 'p'));
  eq('012345678945678', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('y', ',', 'P'));
  eq('012340123456789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('ty,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('t', '4'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('y', ';', 'P'));
  eq('01230123456789', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('y', ',', 'p'));
  eq('01234567895678', cm.getValue());
}, { value: '0123456789'}));
(await testVim('Ty,;', async function(cm, vim, helpers) {
  cm.setCursor(0, 9);
  (await helpers.doKeys('T', '4'));
  cm.setCursor(0, 9);
  (await helpers.doKeys('y', ';', 'p'));
  eq('01234567895678', cm.getValue());
  (await helpers.doKeys('u'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('y', ',', 'P'));
  eq('01230123456789', cm.getValue());
}, { value: '0123456789'}));
(await testVim('vFT', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys('v', 'f', '1'));
  helpers.assertCursorAt(0, 2);
  (await helpers.doKeys('2', 't', ' '));
  helpers.assertCursorAt(0, 8);
  eqCursorPos(new Pos(0, 0), cm.getCursor('anchor'));
  (await helpers.doKeys('<Esc>'));
  eqCursorPos(new Pos(0, 7), cm.getCursor('anchor'));
  (await helpers.doKeys('v', 'F', '3'));
  helpers.assertCursorAt(0, 3);
  eqCursorPos(new Pos(0, 8), cm.getCursor('anchor'));
  (await helpers.doKeys('T', '1'));
  helpers.assertCursorAt(0, 2);
  (await helpers.doKeys('F', '1'));
  helpers.assertCursorAt(0, 1);
  (await helpers.doKeys('F', '1'));
  helpers.assertCursorAt(0, 0);
}, { value: '1123 123 123'}));
(await testVim('vf,;', async function(cm, vim, helpers) { 
  (await helpers.doKeys('0', 'v'));
  (await helpers.doKeys('f', '.'));
  eq('ab.', cm.getSelection());
  (await helpers.doKeys(';'));
  eq('ab.cd.', cm.getSelection());
  (await helpers.doKeys(';'));
  eq('ab.cd.ef.', cm.getSelection());
  (await helpers.doKeys(','));
  eq('ab.cd.', cm.getSelection()); 
  (await helpers.doKeys(';'));
  eq('ab.cd.ef.', cm.getSelection());
  (await helpers.doKeys('2', ','));
  eq('ab.', cm.getSelection());
  (await helpers.doKeys('2', ','));
  eq('ab.', cm.getSelection());
}, { value: 'ab.cd.ef.g'}));
(await testVim('page_motions', async function(cm, vim, helpers) {
  var value = "x".repeat(200).split("").map((_, i)=>i).join("\n");
  cm.setValue(value);
  cm.refresh();
  var lines = 10;
  var textHeight = cm.defaultTextHeight();
  cm.setSize(600, lines*textHeight);
  cm.setCursor(100, 0);
  cm.refresh();
  (await helpers.doKeys('<C-u>'));
  helpers.assertCursorAt(95, 0);
  (await helpers.doKeys('<C-u>'));
  helpers.assertCursorAt(90, 0);
  (await helpers.doKeys('<C-d>'));
  (await helpers.doKeys('<C-d>'));
  helpers.assertCursorAt(100, 0);
  cm.refresh();
  (await helpers.doKeys('<C-f>'));
  cm.refresh();
  helpers.assertCursorAt(110, 0);

  (await helpers.doKeys('<C-b>'));
  cm.refresh();
  helpers.assertCursorAt(100, 0);
  eq(value, cm.getValue());
}));
(await testVim('HML', async function(cm, vim, helpers) {
  cm.refresh();
  var lines = 35;
  var textHeight = cm.defaultTextHeight();
  cm.setSize(600, lines*textHeight);
  cm.setCursor(120, 0);
  (await helpers.doKeys('H'));
  helpers.assertCursorAt(86, 2);
  (await helpers.doKeys('L'));
  helpers.assertCursorAt(120, 4);
  (await helpers.doKeys('M'));
  helpers.assertCursorAt(103,4);
}, { value: (function(){
  var lines = new Array(100);
  var upper = '  xx\n';
  var lower = '    xx\n';
  upper = lines.join(upper);
  lower = lines.join(lower);
  return upper + lower;
})()}));

var zVals = [];
var cursorIndexVals = [];
(await forEach(['zb','zz','zt','z-','z.','z<CR>'], async function(e, idx){
  var lineNum = 250;
  var lines = 35;
  (await testVim(e, async function(cm, vim, helpers) {
    cm.refresh();
    var k1 = e[0];
    var k2 = e.substring(1);
    var textHeight = cm.defaultTextHeight();
    cm.setSize(600, lines*textHeight);
    cm.setCursor(lineNum, 1);
    var originalCursorIndex = cm.indexFromPos(cm.getCursor());
    (await helpers.doKeys(k1, k2));
    zVals[idx] = cm.getScrollInfo().top;
    cursorIndexVals[idx] = {
      before: originalCursorIndex,
      after: cm.indexFromPos(cm.getCursor())
    };
  }, { value: (function(){
    return new Array(500).join('12\n');
  })()}));
}));
(await testVim('zb_to_bottom', async function(cm, vim, helpers){
  cm.refresh();
  var lineNum = 250;
  cm.setSize(600, 35*cm.defaultTextHeight());
  cm.setCursor(lineNum, 0);
  (await helpers.doKeys('z', 'b'));
  var scrollInfo = cm.getScrollInfo();
  eqPixel(scrollInfo.top + scrollInfo.clientHeight, cm.charCoords(new Pos(lineNum, 0), 'local').bottom);
}, { value: (function(){
  return new Array(500).join('\n');
})()}));
(await testVim('zt_to_top', async function(cm, vim, helpers){
  cm.refresh();
  var lineNum = 250;
  cm.setSize(600, 35*cm.defaultTextHeight());
  cm.setCursor(lineNum, 0);
  (await helpers.doKeys('z', 't'));
  eqPixel(cm.getScrollInfo().top, cm.charCoords(new Pos(lineNum, 0), 'local').top);
}, { value: (function(){
  return new Array(500).join('\n');
})()}));
(await testVim('zb<zz', function(cm, vim, helpers){
  eq(zVals[0]<zVals[1], true);
}));
(await testVim('zz<zt', function(cm, vim, helpers){
  eq(zVals[1]<zVals[2], true);
}));
(await testVim('zb==z-', function(cm, vim, helpers){
  eq(zVals[0], zVals[3]);
}));
(await testVim('zz==z.', function(cm, vim, helpers){
  eq(zVals[1], zVals[4]);
}));
(await testVim('zt==z<CR>', function(cm, vim, helpers){
  eq(zVals[2], zVals[5]);
}));
(await testVim('zt_no_cursor_change', function(cm, vim, helpers){
  var cursorIndexes = cursorIndexVals[2];
  eq(cursorIndexes.before, cursorIndexes.after);
}));
(await testVim('z<CR>_cursor_change', function(cm, vim, helpers){
  var cursorIndexes = cursorIndexVals[5];
  eq(cursorIndexes.before, 751);
  eq(cursorIndexes.after, 750);
}));
(await testVim('zz_no_cursor_change', function(cm, vim, helpers){
  var cursorIndexes = cursorIndexVals[1];
  eq(cursorIndexes.before, cursorIndexes.after);
}));
(await testVim('z._cursor_change', function(cm, vim, helpers){
  var cursorIndexes = cursorIndexVals[4];
  eq(cursorIndexes.before, 751);
  eq(cursorIndexes.after, 750);
}));
(await testVim('zb_no_cursor_change', function(cm, vim, helpers){
  var cursorIndexes = cursorIndexVals[0];
  eq(cursorIndexes.before, cursorIndexes.after);
}));
(await testVim('z-_cursor_change', function(cm, vim, helpers){
  var cursorIndexes = cursorIndexVals[3];
  eq(cursorIndexes.before, 751);
  eq(cursorIndexes.after, 750);
}));

var moveTillCharacterSandbox =
  'The quick brown fox \n';
(await testVim('moveTillCharacter', async function(cm, vim, helpers){
  cm.setCursor(0, 0);
  // Search for the 'q'.
  (await helpers.doKeys('/', 'q', '\n'));
  eq(4, cm.getCursor().ch);
  // Jump to just before the first o in the list.
  (await helpers.doKeys('t'));
  (await helpers.doKeys('o'));
  eq('The quick brown fox \n', cm.getValue());
  // Delete that one character.
  (await helpers.doKeys('d'));
  (await helpers.doKeys('t'));
  (await helpers.doKeys('o'));
  eq('The quick bown fox \n', cm.getValue());
  // Delete everything until the next 'o'.
  (await helpers.doKeys('.'));
  eq('The quick box \n', cm.getValue());
  // An unmatched character should have no effect.
  (await helpers.doKeys('d'));
  (await helpers.doKeys('t'));
  (await helpers.doKeys('q'));
  eq('The quick box \n', cm.getValue());
  // Matches should only be possible on single lines.
  (await helpers.doKeys('d'));
  (await helpers.doKeys('t'));
  (await helpers.doKeys('z'));
  eq('The quick box \n', cm.getValue());
  // After all that, the search for 'q' should still be active, so the 'N' command
  // can run it again in reverse. Use that to delete everything back to the 'q'.
  (await helpers.doKeys('d'));
  (await helpers.doKeys('N'));
  eq('The ox \n', cm.getValue());
  eq(4, cm.getCursor().ch);
}, { value: moveTillCharacterSandbox}));
(await testVim('searchForPipe', async function(cm, vim, helpers){
  CodeMirror.Vim.setOption('pcre', false);
  cm.setCursor(0, 0);
  // Search for the '|'.
  (await helpers.doKeys('/', '|', '\n'));
  eq(4, cm.getCursor().ch);
}, { value: 'this|that'}));


var scrollMotionSandbox =
  '\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n';
(await testVim('scrollMotion', async function(cm, vim, helpers){
  var prevCursor, prevScrollInfo;
  cm.setSize(320, 200);
  cm.setCursor(0, 0);
  cm.refresh();
  // ctrl-y at the top of the file should have no effect.
  (await helpers.doKeys('<C-y>'));
  eq(0, cm.getCursor().line);
  cm.refresh();
  prevScrollInfo = cm.getScrollInfo();
  (await helpers.doKeys('<C-e>'));
  eq(1, cm.getCursor().line);
  cm.refresh();
  is(prevScrollInfo.top < cm.getScrollInfo().top);
  // Jump to the end of the sandbox.
  cm.setCursor(1000, 0);
  cm.refresh();
  prevCursor = cm.getCursor();
  // ctrl-e at the bottom of the file should have no effect.
  (await helpers.doKeys('<C-e>'));
  eq(prevCursor.line, cm.getCursor().line);
  prevScrollInfo = cm.getScrollInfo();
  (await helpers.doKeys('<C-y>'));
  eq(prevCursor.line - 1, cm.getCursor().line, "Y");
  is(prevScrollInfo.top > cm.getScrollInfo().top);
}, { value: scrollMotionSandbox}));

var squareBracketMotionSandbox = ''+
  '({\n'+//0
  '  ({\n'+//11
  '  /*comment {\n'+//2
  '            */(\n'+//3
  '#else                \n'+//4
  '  /*       )\n'+//5
  '#if        }\n'+//6
  '  )}*/\n'+//7
  ')}\n'+//8
  '{}\n'+//9
  '#else {{\n'+//10
  '{}\n'+//11
  '}\n'+//12
  '{\n'+//13
  '#endif\n'+//14
  '}\n'+//15
  '}\n'+//16
  '#else';//17
(await testVim('[[, ]]', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys(']', ']'));
  helpers.assertCursorAt(9,0);
  (await helpers.doKeys('2', ']', ']'));
  helpers.assertCursorAt(13,0);
  (await helpers.doKeys(']', ']'));
  helpers.assertCursorAt(17,0);
  (await helpers.doKeys('[', '['));
  helpers.assertCursorAt(13,0);
  (await helpers.doKeys('2', '[', '['));
  helpers.assertCursorAt(9,0);
  (await helpers.doKeys('[', '['));
  helpers.assertCursorAt(0,0);
}, { value: squareBracketMotionSandbox}));
(await testVim('[], ][', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doKeys(']', '['));
  helpers.assertCursorAt(12,0);
  (await helpers.doKeys('2', ']', '['));
  helpers.assertCursorAt(16,0);
  (await helpers.doKeys(']', '['));
  helpers.assertCursorAt(17,0);
  (await helpers.doKeys('[', ']'));
  helpers.assertCursorAt(16,0);
  (await helpers.doKeys('2', '[', ']'));
  helpers.assertCursorAt(12,0);
  (await helpers.doKeys('[', ']'));
  helpers.assertCursorAt(0,0);
}, { value: squareBracketMotionSandbox}));
(await testVim('[{, ]}', async function(cm, vim, helpers) {
  cm.setCursor(4, 10);
  (await helpers.doKeys('[', '{'));
  helpers.assertCursorAt(2,12);
  (await helpers.doKeys('2', '[', '{'));
  helpers.assertCursorAt(0,1);
  cm.setCursor(4, 10);
  (await helpers.doKeys(']', '}'));
  helpers.assertCursorAt(6,11);
  (await helpers.doKeys('2', ']', '}'));
  helpers.assertCursorAt(8,1);
  cm.setCursor(0,1);
  (await helpers.doKeys(']', '}'));
  helpers.assertCursorAt(8,1);
  (await helpers.doKeys('[', '{'));
  helpers.assertCursorAt(0,1);
}, { value: squareBracketMotionSandbox}));
(await testVim('[(, ])', async function(cm, vim, helpers) {
  cm.setCursor(4, 10);
  (await helpers.doKeys('[', '('));
  helpers.assertCursorAt(3,14);
  (await helpers.doKeys('2', '[', '('));
  helpers.assertCursorAt(0,0);
  cm.setCursor(4, 10);
  (await helpers.doKeys(']', ')'));
  helpers.assertCursorAt(5,11);
  (await helpers.doKeys('2', ']', ')'));
  helpers.assertCursorAt(8,0);
  (await helpers.doKeys('[', '('));
  helpers.assertCursorAt(0,0);
  (await helpers.doKeys(']', ')'));
  helpers.assertCursorAt(8,0);
}, { value: squareBracketMotionSandbox}));
(await testVim('[*, ]*, [/, ]/', async function(cm, vim, helpers) {
  (await forEach(['*', '/'], async function(key){
    cm.setCursor(7, 0);
    (await helpers.doKeys('2', '[', key));
    helpers.assertCursorAt(2,2);
    (await helpers.doKeys('2', ']', key));
    helpers.assertCursorAt(7,5);
  }));
}, { value: squareBracketMotionSandbox}));
(await testVim('[#, ]#', async function(cm, vim, helpers) {
  cm.setCursor(10, 3);
  (await helpers.doKeys('2', '[', '#'));
  helpers.assertCursorAt(4,0);
  (await helpers.doKeys('5', ']', '#'));
  helpers.assertCursorAt(17,0);
  cm.setCursor(10, 3);
  (await helpers.doKeys(']', '#'));
  helpers.assertCursorAt(14,0);
}, { value: squareBracketMotionSandbox}));
(await testVim('[m, ]m, [M, ]M', async function(cm, vim, helpers) {
  cm.setCursor(11, 0);
  (await helpers.doKeys('[', 'm'));
  helpers.assertCursorAt(10,7);
  (await helpers.doKeys('4', '[', 'm'));
  helpers.assertCursorAt(1,3);
  (await helpers.doKeys('5', ']', 'm'));
  helpers.assertCursorAt(11,0);
  (await helpers.doKeys('[', 'M'));
  helpers.assertCursorAt(9,1);
  (await helpers.doKeys('3', ']', 'M'));
  helpers.assertCursorAt(15,0);
  (await helpers.doKeys('5', '[', 'M'));
  helpers.assertCursorAt(7,3);
}, { value: squareBracketMotionSandbox}));

(await testVim('i_indent_right', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedValue = '   word1\nword2\nword3 ';
  (await helpers.doKeys('i', '<C-t>'));
  eq(expectedValue, cm.getValue());
  helpers.assertCursorAt(0, 5);
}, { value: ' word1\nword2\nword3 ', indentUnit: 2 }));
(await testVim('i_indent_left', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  var expectedValue = ' word1\nword2\nword3 ';
  (await helpers.doKeys('i', '<C-d>'));
  eq(expectedValue, cm.getValue());
  helpers.assertCursorAt(0, 1);
}, { value: '   word1\nword2\nword3 ', indentUnit: 2 }));

// Ex mode tests
(await testVim('ex_go_to_line', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('4'));
  helpers.assertCursorAt(3, 0);
  (await helpers.doEx('4-1'));
  helpers.assertCursorAt(2, 0);
}, { value: 'a\nb\nc\nd\ne\n'}));
(await testVim('ex_go_to_mark', async function(cm, vim, helpers) {
  cm.setCursor(3, 0);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(0, 0);
  (await helpers.doEx('\'a'));
  helpers.assertCursorAt(3, 0);
}, { value: 'a\nb\nc\nd\ne\n'}));
(await testVim('ex_go_to_line_offset', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('+3'));
  helpers.assertCursorAt(3, 0);
  (await helpers.doEx('-1'));
  helpers.assertCursorAt(2, 0);
  (await helpers.doEx('.2'));
  helpers.assertCursorAt(4, 0);
  (await helpers.doEx('.-3'));
  helpers.assertCursorAt(1, 0);
}, { value: 'a\nb\nc\nd\ne\n'}));
(await testVim('ex_go_to_mark_offset', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('m', 'a'));
  cm.setCursor(0, 0);
  (await helpers.doEx('\'a1'));
  helpers.assertCursorAt(3, 0);
  (await helpers.doEx('\'a-1'));
  helpers.assertCursorAt(1, 0);
  (await helpers.doEx('\'a+2'));
  helpers.assertCursorAt(4, 0);
}, { value: 'a\nb\nc\nd\ne\n'}));
(await testVim('ex_advanced_range_syntax', async function(cm, vim, helpers) {
  (await helpers.doEx('0/m'));
  helpers.assertCursorAt(3, 0);
  (await helpers.doKeys('m', 'a'));
  (await helpers.doEx('/m//m/'));
  helpers.assertCursorAt(8, 0);
  (await helpers.doEx("'a,.y x"));
  (await helpers.doEx('10?m??m?put! x'));
  eq("1\n2\n3\n4m\n5\n6\n4m\n5\n6\n7m\n8\n9m\n7m\n8\n9m\n10\n", cm.getValue()); 
  (await helpers.doEx('1+++2+/m/,1/m//m/+2-/m/+2d'));
  eq("1\n2\n3\n4m\n5\n6\n7m\n8\n9m\n10\n", cm.getValue()); 
  (await helpers.doKeys('3', ':'));
  eq(cm.getWrapperElement().querySelector("input").value, ".,.+2");
  (await helpers.doKeys('d', '\n'));
  eq("1\n2\n3\n4m\n5\n6\n10\n", cm.getValue()); 
}, {value: "1\n2\n3\n4m\n5\n6\n7m\n8\n9m\n10\n"}));
(await testVim('ex_write', async function(cm, vim, helpers) {
  var tmp = CodeMirror.commands.save;
  var written;
  var actualCm;
  CodeMirror.commands.save = function(cm) {
    written = true;
    actualCm = cm;
  };
  // Test that w, wr, wri ... write all trigger :write.
  var command = 'write';
  for (var i = 1; i < command.length; i++) {
    written = false;
    actualCm = null;
    (await helpers.doEx(command.substring(0, i)));
    eq(written, true);
    eq(actualCm, cm);
  }
  CodeMirror.commands.save = tmp;
}));
(await testVim('ex_delete', async function(cm, vim, helpers) {
  (await helpers.doKeys("j"));
  (await helpers.doEx('delete'));
  eq('l 1\nl 3\nl 4\n', cm.getValue());
  (await helpers.doEx('d'));
  eq('l 1\nl 4\n', cm.getValue());
}, { value: 'l 1\nl 2\nl 3\nl 4\n'}));
(await testVim('ex_sort', async function(cm, vim, helpers) {
  (await helpers.doEx('sort'));
  eq('Z\na\nb\nc\nd', cm.getValue());
}, { value: 'b\nZ\nd\nc\na'}));
(await testVim('ex_sort_reverse', async function(cm, vim, helpers) {
  (await helpers.doEx('sort!'));
  eq('d\nc\nb\na', cm.getValue());
}, { value: 'b\nd\nc\na'}));
(await testVim('ex_sort_range', async function(cm, vim, helpers) {
  (await helpers.doEx('2,3sort'));
  eq('b\nc\nd\na', cm.getValue());
}, { value: 'b\nd\nc\na'}));
(await testVim('ex_sort_oneline', async function(cm, vim, helpers) {
  (await helpers.doEx('2sort'));
  // Expect no change.
  eq('b\nd\nc\na', cm.getValue());
}, { value: 'b\nd\nc\na'}));
(await testVim('ex_sort_ignoreCase', async function(cm, vim, helpers) {
  (await helpers.doEx('sort i'));
  eq('a\nb\nc\nd\nZ', cm.getValue());
}, { value: 'b\nZ\nd\nc\na'}));
(await testVim('ex_sort_unique', async function(cm, vim, helpers) {
  (await helpers.doEx('sort u'));
  eq('Z\na\nb\nc\nd', cm.getValue());
}, { value: 'b\nZ\na\na\nd\na\nc\na'}));
(await testVim('ex_sort_decimal', async function(cm, vim, helpers) {
  (await helpers.doEx('sort d'));
  eq('d3\n s5\n6\n.9', cm.getValue());
}, { value: '6\nd3\n s5\n.9'}));
(await testVim('ex_sort_decimal_negative', async function(cm, vim, helpers) {
  (await helpers.doEx('sort d'));
  eq('z-9\nd3\n s5\n6\n.9', cm.getValue());
}, { value: '6\nd3\n s5\n.9\nz-9'}));
(await testVim('ex_sort_decimal_reverse', async function(cm, vim, helpers) {
  (await helpers.doEx('sort! d'));
  eq('.9\n6\n s5\nd3', cm.getValue());
}, { value: '6\nd3\n s5\n.9'}));
(await testVim('ex_sort_hex', async function(cm, vim, helpers) {
  (await helpers.doEx('sort x'));
  eq(' s5\n6\n.9\n&0xB\nd3', cm.getValue());
}, { value: '6\nd3\n s5\n&0xB\n.9'}));
(await testVim('ex_sort_octal', async function(cm, vim, helpers) {
  (await helpers.doEx('sort o'));
  eq('.9\n.8\nd3\n s5\n6', cm.getValue());
}, { value: '6\nd3\n s5\n.9\n.8'}));
(await testVim('ex_sort_decimal_mixed', async function(cm, vim, helpers) {
  (await helpers.doEx('sort d'));
  eq('z\ny\nc1\nb2\na3', cm.getValue());
}, { value: 'a3\nz\nc1\ny\nb2'}));
(await testVim('ex_sort_decimal_mixed_reverse', async function(cm, vim, helpers) {
  (await helpers.doEx('sort! d'));
  eq('a3\nb2\nc1\nz\ny', cm.getValue());
}, { value: 'a3\nz\nc1\ny\nb2'}));
(await testVim('ex_sort_pattern_alpha', async function(cm, vim, helpers) {
  (await helpers.doEx('sort r/[a-z]/'));
  eq('a3\nb2\nc1\ny\nz', cm.getValue());
}, { value: 'z\ny\nc1\nb2\na3'}));
(await testVim('ex_sort_pattern_alpha_reverse', async function(cm, vim, helpers) {
  (await helpers.doEx('sort! r /[a-z]/'));
  eq('z\ny\nc1\nb2\na3', cm.getValue());
}, { value: 'z\ny\nc1\nb2\na3'}));
(await testVim('ex_sort_pattern_alpha_ignoreCase', async function(cm, vim, helpers) {
  (await helpers.doEx('sort ri/[a-z]/'));
  eq('a3\nb2\nC1\nY\nz', cm.getValue());
}, { value: 'z\nY\nC1\nb2\na3'}));
(await testVim('ex_sort_pattern_alpha_longer', async function(cm, vim, helpers) {
  (await helpers.doEx('sort r/[a-z]+/'));
  eq('a\naa\nab\nade\nadele\nadelle\nadriana\nalex\nalexandra\nb\nc\ny\nz', cm.getValue());
}, { value: 'z\nab\naa\nade\nadelle\nalexandra\nalex\nadriana\nadele\ny\nc\nb\na'}));
(await testVim('ex_sort_pattern_alpha_only', async function(cm, vim, helpers) {
  (await helpers.doEx('sort r/^[a-z]$/'));
  eq('z1\ny2\na3\nb\nc', cm.getValue());
}, { value: 'z1\ny2\na3\nc\nb'}));
(await testVim('ex_sort_pattern_alpha_only_reverse', async function(cm, vim, helpers) {
  (await helpers.doEx('sort! r/^[a-z]$/'));
  eq('c\nb\nz1\ny2\na3', cm.getValue());
}, { value: 'z1\ny2\na3\nc\nb'}));
(await testVim('ex_sort_pattern_alpha_num', async function(cm, vim, helpers) {
  (await helpers.doEx('sort r/[a-z][0-9]/'));
  eq('c\nb\na3\ny2\nz1', cm.getValue());
}, { value: 'z1\ny2\na3\nc\nb'}));
(await testVim('ex_sort_pattern_no_r', async function(cm, vim, helpers) {
  (await helpers.doEx('sort /in/'));
  eq(' z \n in\n\n3 in a \n1 in c \n2 in d ', cm.getValue());
  (await helpers.doEx('sort r/in/'));
  eq(' z \n\n in\n3 in a \n1 in c \n2 in d ', cm.getValue());
  (await helpers.doEx('sort r/. in/'));  
  eq(' z \n\n in\n1 in c \n2 in d \n3 in a ', cm.getValue());
  (await helpers.doEx('sort /./'));
  eq('\n3 in a \n1 in c \n2 in d \n in\n z ', cm.getValue());  
  (await helpers.doEx('sort /in d/'));
  eq('\n3 in a \n1 in c \n in\n z \n2 in d ', cm.getValue());
}, { value: '1 in c \n z \n2 in d \n in\n3 in a \n'}));
// test for :global command
(await testVim('ex_global', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('g/one/s//two'));
  eq('two one\n two one\n two one', cm.getValue());
  (await helpers.doEx('1,2g/two/s//one'));
  eq('one one\n one one\n two one', cm.getValue());
  (await helpers.doEx('g/^ /'));
  eq(' one one\n two one', helpers.getNotificationText());
}, {value: 'one one\n one one\n one one'}));
(await testVim('ex_normal', async function(cm, vim, helpers) {
  (await helpers.doEx('norm /<Esc>"/p'));
  (await helpers.doEx('norm /x<Cr>"/p'));
  (await helpers.doEx('norm /h<Esc>"/p'));
  (await helpers.doEx('norm /one<Cr>3li<Right> <Esc>"/p'));
  eq('one one\nxxx\none one\none one', cm.getValue());
  
  cm.setCursor(0, 0);
  (await helpers.doEx('g/one/normal    cw 1<lt>Esc><Esc>$i$'));
  (await helpers.doKeys("rt"));
  eq(' 1<Esc> on$e\nxxx\n 1<Esc> on$e\n 1<Esc> on$t', cm.getValue());
  (await helpers.doKeys('/', '<', '\n'));
  (await helpers.doKeys('x', 'x', 'p'));
  eq(' 1sEc> on$e\nxxx\n 1<Esc> on$e\n 1<Esc> on$t', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doEx('map k j'));
  (await helpers.doEx('normal kkk'));
  helpers.assertCursorAt(3, 0);
  (await helpers.doEx('normal! kkk'));
  helpers.assertCursorAt(0, 0);
}, {value: 'one one\nx\none\none one'}));
(await testVim('ex_global_substitute_join', async function(cm, vim, helpers) {
  (await helpers.doEx('g/o/s/\\n/;'));
  eq('one;two\nthree\nfour;five\n', cm.getValue());
}, {value: 'one\ntwo\nthree\nfour\nfive\n'}));
(await testVim('ex_global_substitute_split', async function(cm, vim, helpers) {
  (await helpers.doEx('g/e/s/[or]/\\n'));
  eq('\nne\ntwo\nth\nee\nfour\nfive\n', cm.getValue());
}, {value: 'one\ntwo\nthree\nfour\nfive\n'}));
(await testVim('ex_global_delete', async function(cm, vim, helpers) {
  (await helpers.doEx('g/e/d\\n'));
  eq('two\nfour\nsix\n---', cm.getValue());
  (await helpers.doKeys('u'));
  (await helpers.doEx('g/e/g/v/d\\n'));
  eq('one\ntwo\nthree\nfour\nsix\nnine\n---', cm.getValue());
}, {value: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nnine\n---'}));
(await testVim('ex_global_confirm', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('g/one/s//two/gc'));
  (await helpers.doKeys('n'));
  (await helpers.doKeys('y'));
  (await helpers.doKeys('a'));
  (await helpers.doKeys('q'));
  (await helpers.doKeys('y'));
  eq('one two\n two two\n one one\n two one\n one one', cm.getValue());
}, {value: 'one one\n one one\n one one\n one one\n one one'}));
// test for :vglobal command
(await testVim('ex_vglobal', async function(cm, vim, helpers) {
  (await helpers.doEx('v/e/s/o/e'));
  eq('one\n twe\n three\n feur\n five\n', cm.getValue());
  (await helpers.doEx('v/[vw]'));
  eq('one\n three\n feur\n', helpers.getNotificationText());
}, {value: 'one\n two\n three\n four\n five\n'}));
// Basic substitute tests.
(await testVim('ex_substitute_same_line', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doEx('s/one/two/g'));
  eq('one one\n two two', cm.getValue());
}, { value: 'one one\n one one'}));
(await testVim('ex_substitute_alternate_separator', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doEx('s#o/e#two#g'));
  eq('o/e o/e\n two two', cm.getValue());
}, { value: 'o/e o/e\n o/e o/e'}));
(await testVim('ex_substitute_full_file', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doEx('%s/one/two/g'));
  eq('two two\n two two', cm.getValue());
}, { value: 'one one\n one one'}));
(await testVim('ex_substitute_input_range', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doEx('1,3s/\\d/0/g'));
  eq('0\n0\n0\n4', cm.getValue());
}, { value: '1\n2\n3\n4' }));
(await testVim('ex_substitute_range_current_to_input', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  (await helpers.doEx('.,3s/\\d/0/g'));
  eq('1\n0\n0\n4', cm.getValue());
}, { value: '1\n2\n3\n4' }));
(await testVim('ex_substitute_range_input_to_current', async function(cm, vim, helpers) {
  cm.setCursor(3, 0);
  (await helpers.doEx('2,.s/\\d/0/g'));
  eq('1\n0\n0\n0\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_range_offset', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doEx('-1,+1s/\\d/0/g'));
  eq('1\n0\n0\n0\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_range_implicit_offset', async function(cm, vim, helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('.1,.3s/\\d/0/g'));
  eq('1\n0\n0\n0\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_to_eof', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doEx('.,$s/\\d/0/g'));
  eq('1\n2\n0\n0\n0', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_to_relative_eof', async function(cm, vim, helpers) {
  cm.setCursor(4, 0);
  (await helpers.doEx('2,$-2s/\\d/0/g'));
  eq('1\n0\n0\n4\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_range_mark', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('ma'));
  cm.setCursor(0, 0);
  (await helpers.doEx('.,\'as/\\d/0/g'));
  eq('0\n0\n0\n4\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_range_mark_offset', async function(cm, vim, helpers) {
  cm.setCursor(2, 0);
  (await helpers.doKeys('ma'));
  cm.setCursor(0, 0);
  (await helpers.doEx('\'a-1,\'a+1s/\\d/0/g'));
  eq('1\n0\n0\n0\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_visual_range', async function(cm, vim, helpers) {
  cm.setCursor(1, 0);
  // Set last visual mode selection marks '< and '> at lines 2 and 4
  (await helpers.doKeys('V', '2', 'j', 'v'));
  (await helpers.doKeys(':'));
  eq(document.activeElement.value, "'<,'>");
  (await helpers.doKeys('s/\\d/0/g', '\n'));
  eq('1\n0\n0\n0\n5', cm.getValue());
}, { value: '1\n2\n3\n4\n5' }));
(await testVim('ex_substitute_empty_query', async function(cm, vim, helpers) {
  // If the query is empty, use last query.
  cm.setCursor(1, 0);
  (await helpers.doKeys('/', '1\n'));
  (await helpers.doEx('s//b/g'));
  eq('abb ab2 ab3', cm.getValue());
}, { value: 'a11 a12 a13' }));
(await testVim('ex_substitute_javascript', async function(cm, vim, helpers) {
  CodeMirror.Vim.setOption('pcre', false);
  cm.setCursor(1, 0);
  // Throw all the things that javascript likes to treat as special values
  // into the replace part. All should be literal (this is VIM).
  (await helpers.doEx('s/\\(\\d\\+\\)/$$ $\' $` $& \\1/g'));
  eq('a $$ $\' $` $& 0 b', cm.getValue());

  cm.setValue('W12345678OR12345D');
  (await helpers.doEx('s/\\d//g'));
  eq('WORD', cm.getValue());
}, { value: 'a 0 b' }));
(await testVim('ex_substitute_empty_arguments', async function(cm,vim,helpers) {
  cm.setCursor(0, 0);
  (await helpers.doEx('s/a/b/g'));
  cm.setCursor(1, 0);
  (await helpers.doEx('s'));
  eq('b b\nb a', cm.getValue());
}, {value: 'a a\na a'}));
(await testVim('ex_substitute_highlight', async function(cm,vim,helpers) {
  is(!searchHighlighted(vim));
  (await helpers.doKeys(':s/a'));
  is(searchHighlighted(vim));
  (await helpers.doKeys('\n'));
  is(!searchHighlighted(vim));
}, {value: 'a a\na a'}));
(await testVim('ex_substitute_nopcre_special', async function(cm, vim, helpers) {
  CodeMirror.Vim.setOption('pcre', false);

  cm.setValue('aabb1cxyz$^o aabb2cxyz$^o aabb3cxyz$^o aabb4cxyz$^o ');
  (await helpers.doEx(
    's/'
    + '\\v<a*(b|\\d){3}c?[x-z]+\\$\\^.> '
    + '\\V\\<a\\*\\(b\\|\\d\\)\\{3\\}c\\?\\[x-z]\\+$^\\.\\> '
    + '\\m\\<a*\\(b\\|\\d\\)\\{3}c\\?[x-z]\\+\\$\\^.\\> '
    + '\\M\\<a\\*\\(b\\|\\d\\)\\{3}c\\?\\[x-z]\\+\\$\\^\\.\\>'
    + '/M\\4 m\\3 V\\2 v\\1/'
  ));
  eq('M4 m3 V2 v1 ', cm.getValue());
  
  cm.setValue('10 12 13 42');
  (await helpers.doEx('s/\\m\\(1\\)\\v\\ze(\\d+)/\\2\\1 a\\1/g'));
  eq('01 a10 21 a12 31 a13 42', cm.getValue());
  (await helpers.doEx('s/2\\zs\\>/b/g'));
  eq('01 a10 21 a12b 31 a13 42b', cm.getValue());
  (await helpers.doEx('s/\\m\\<\\d\\+ //g'));
  eq('a10 a12b a13 42b', cm.getValue());
}, { value: '' }));

// More complex substitute tests that test both pcre and nopcre options.
async function testSubstitute(name, options) {
  (await testVim(name + '_pcre', async function(cm, vim, helpers) {
    cm.setCursor(1, 0);
    CodeMirror.Vim.setOption('pcre', true);
    (await helpers.doEx(options.expr));
    eq(options.expectedValue, cm.getValue());
  }, options));
  // If no noPcreExpr is defined, assume that it's the same as the expr.
  var noPcreExpr = options.noPcreExpr ? options.noPcreExpr : options.expr;
  (await testVim(name + '_nopcre', async function(cm, vim, helpers) {
    cm.setCursor(1, 0);
    CodeMirror.Vim.setOption('pcre', false);
    (await helpers.doEx(noPcreExpr));
    eq(options.expectedValue, cm.getValue());
  }, options));
}
(await testSubstitute('ex_substitute_capture', {
  value: 'a11 a12 a13',
  expectedValue: 'a1111 a1212 a1313',
  // $n is a backreference
  expr: 's/(\\d+)/$1$1/g',
  // \n is a backreference.
  noPcreExpr: 's/\\(\\d\\+\\)/\\1\\1/g'}));
(await testSubstitute('ex_substitute_capture2', {
  value: 'a 0 b',
  expectedValue: 'a $00 b',
  expr: 's/(\\d+)/$$$1$1/g',
  noPcreExpr: 's/\\(\\d\\+\\)/$\\1\\1/g'}));
(await testSubstitute('ex_substitute_nocapture', {
  value: 'a11 a12 a13',
  expectedValue: 'a$1$1 a$1$1 a$1$1',
  expr: 's/(\\d+)/$$1$$1/g',
  noPcreExpr: 's/\\(\\d\\+\\)/$1$1/g'}));
(await testSubstitute('ex_substitute_nocapture2', {
  value: 'a 0 b',
  expectedValue: 'a $10 b',
  expr: 's/(\\d+)/$$1$1/g',
  noPcreExpr: 's/\\(\\d\\+\\)/\\$1\\1/g'}));
(await testSubstitute('ex_substitute_nocapture', {
  value: 'a b c',
  expectedValue: 'a $ c',
  expr: 's/b/$$/',
  noPcreExpr: 's/b/$/'}));
(await testSubstitute('ex_substitute_slash_regex', {
  value: 'one/two \n three/four',
  expectedValue: 'one|two \n three|four',
  expr: '%s/\\//|'}));
(await testSubstitute('ex_substitute_pipe_regex', {
  value: 'one|two \n three|four',
  expectedValue: 'one,two \n three,four',
  expr: '%s/\\|/,/',
  noPcreExpr: '%s/|/,/'}));
(await testSubstitute('ex_substitute_or_regex', {
  value: 'one|two \n three|four',
  expectedValue: 'ana|twa \n thraa|faar',
  expr: '%s/o|e|u/a/g',
  noPcreExpr: '%s/o\\|e\\|u/a/g'}));
(await testSubstitute('ex_substitute_or_word_regex', {
  value: 'one|two \n three|four',
  expectedValue: 'five|five \n three|four',
  expr: '%s/(one|two)/five/g',
  noPcreExpr: '%s/\\(one\\|two\\)/five/g'}));
(await testSubstitute('ex_substitute_forward_slash_regex', {
    value: 'forward slash \/ was here',
  expectedValue: 'forward slash  was here',
  expr: '%s#\\/##g',
  noPcreExpr: '%s#/##g'}));
(await testVim("ex_substitute_ampersand_pcre", async function(cm, vim, helpers) {
    cm.setCursor(0, 0);
    CodeMirror.Vim.setOption('pcre', true);
    (await helpers.doEx('%s/foo/namespace.&/'));
    eq("namespace.foo", cm.getValue());
  }, { value: 'foo' }));
(await testVim("ex_substitute_ampersand_multiple_pcre", async function(cm, vim, helpers) {
    cm.setCursor(0, 0);
    CodeMirror.Vim.setOption('pcre', true);
    (await helpers.doEx('%s/f.o/namespace.&/'));
    eq("namespace.foo\nnamespace.fzo", cm.getValue());
  }, { value: 'foo\nfzo' }));
(await testVim("ex_escaped_ampersand_should_not_substitute_pcre", async function(cm, vim, helpers) {
    cm.setCursor(0, 0);
    CodeMirror.Vim.setOption('pcre', true);
    (await helpers.doEx('%s/foo/namespace.\\&/'));
    eq("namespace.&", cm.getValue());
  }, { value: 'foo' }));
(await testSubstitute('ex_substitute_backslashslash_regex', {
  value: 'one\\two \n three\\four',
  expectedValue: 'one,two \n three,four',
  expr: '%s/\\\\/,'}));
(await testSubstitute('ex_substitute_slash_replacement', {
  value: 'one,two \n three,four',
  expectedValue: 'one/two \n three/four',
  expr: '%s/,/\\/'}));
(await testSubstitute('ex_substitute_backslash_replacement', {
  value: 'one,two \n three,four',
  expectedValue: 'one\\two \n three\\four',
  expr: '%s/,/\\\\/g'}));
(await testSubstitute('ex_substitute_multibackslash_replacement', {
  value: 'one,two \n three,four',
  expectedValue: 'one\\\\\\\\two \n three\\\\\\\\four', // 2*8 backslashes.
  expr: '%s/,/\\\\\\\\\\\\\\\\/g'})); // 16 backslashes.
(await testSubstitute('ex_substitute_dollar_assertion', {
  value: 'one,two \n three,four',
  expectedValue: 'one,two ,\n three,four,',
  expr: '%s/$/,/g'}));
(await testSubstitute('ex_substitute_dollar_assertion_empty_lines', {
  value: '\n\n\n\n\n\n',
  expectedValue: ';\n;\n;\n;\n;\n;\n;',
  expr: '%s/$/;/g'}));
(await testSubstitute('ex_substitute_dollar_literal', {
  value: 'one$two\n$three\nfour$\n$',
  expectedValue: 'one,two\n,three\nfour,\n,',
  expr: '%s/\\$/,/g'}));
(await testSubstitute('ex_substitute_newline_match', {
  value: 'one,two \n three,four',
  expectedValue: 'one,two , three,four',
  expr: '%s/\\n/,/g'}));
(await testSubstitute('ex_substitute_newline_join_global', {
  value: 'one,two \n three,four \n five \n six',
  expectedValue: 'one,two \n three,four , five \n six',
  expr: '2s/\\n/,/g'}));
(await testSubstitute('ex_substitute_newline_join_noglobal', {
  value: 'one,two \n three,four \n five \n six\n',
  expectedValue: 'one,two \n three,four , five , six\n',
  expr: '2,3s/\\n/,/'}));
(await testSubstitute('ex_substitute_newline_replacement', {
  value: 'one,two, \n three,four,',
  expectedValue: 'one\ntwo\n \n three\nfour\n',
  expr: '%s/,/\\n/g'}));
(await testSubstitute('ex_substitute_newline_multiple_splits', {
  value: 'one,two, \n three,four,five,six, \n seven,',
  expectedValue: 'one,two, \n three\nfour\nfive\nsix\n \n seven,',
  expr: '2s/,/\\n/g'}));
(await testSubstitute('ex_substitute_newline_first_occurrences', {
  value: 'one,two, \n three,four,five,six, \n seven,',
  expectedValue: 'one\ntwo, \n three\nfour,five,six, \n seven\n',
  expr: '%s/,/\\n/'}));
(await testSubstitute('ex_substitute_braces_word', {
  value: 'ababab abb ab{2}',
  expectedValue: 'ab abb ab{2}',
  expr: '%s/(ab){2}//g',
  noPcreExpr: '%s/\\(ab\\)\\{2\\}//g'}));
(await testSubstitute('ex_substitute_braces_range', {
  value: 'a aa aaa aaaa',
  expectedValue: 'a   a',
  expr: '%s/a{2,3}//g',
  noPcreExpr: '%s/a\\{2,3\\}//g'}));
(await testSubstitute('ex_substitute_braces_literal', {
  value: 'ababab abb ab{2}',
  expectedValue: 'ababab abb ',
  expr: '%s/ab\\{2\\}//g',
  noPcreExpr: '%s/ab{2}//g'}));
(await testSubstitute('ex_substitute_braces_char', {
  value: 'ababab abb ab{2}',
  expectedValue: 'ababab  ab{2}',
  expr: '%s/ab{2}//g',
  noPcreExpr: '%s/ab\\{2\\}//g'}));
(await testSubstitute('ex_substitute_braces_no_escape', {
  value: 'ababab abb ab{2}',
  expectedValue: 'ababab  ab{2}',
  expr: '%s/ab{2}//g',
  noPcreExpr: '%s/ab\\{2}//g'}));
(await testSubstitute('ex_substitute_count', {
  value: '1\n2\n3\n4',
  expectedValue: '1\n0\n0\n4',
  expr: 's/\\d/0/i 2'}));
(await testSubstitute('ex_substitute_count_with_range', {
  value: '1\n2\n3\n4',
  expectedValue: '1\n2\n0\n0',
  expr: '1,3s/\\d/0/ 3'}));
(await testSubstitute('ex_substitute_not_global', {
  value: 'aaa\nbaa\ncaa',
  expectedValue: 'xaa\nbxa\ncxa',
  expr: '%s/a/x/'}));
(await testSubstitute('ex_substitute_optional', {
  value: 'aaa  aa\n aa',
  expectedValue: '<aaa> <> <aa>\n<> <aa>',
  expr: '%s/(a*)/<$1>/g',
  noPcreExpr: '%s/\\(a*\\)/<\\1>/g'}));
(await testSubstitute('ex_substitute_empty_match', {
  value: 'aaa  aa\n aa\nbb\n',
  expectedValue: '<aaa>  <aa>\n <aa>\nbb<>\n<>',
  expr: '%s/(a+|$)/<$1>/g',
  noPcreExpr: '%s/\\(a\\+\\|$\\)/<\\1>/g'}));
(await testSubstitute('ex_substitute_empty_or_match', {
  value: '1234\n567\n89\n0\n',
  expectedValue: '<12><34>\n<56>7<>\n<89>\n0<>\n<>',
  expr: '%s/(..|$)/<$1>/g',
  noPcreExpr: '%s/\\(..\\|$\\)/<\\1>/g'}));
async function testSubstituteConfirm(name, command, initialValue, expectedValue, keys, finalPos) {
  (await testVim(name, async function(cm, vim, helpers) {
    (await helpers.doEx(command));
    for (var i = 0; i < keys.length; i++) {
      (await helpers.doKeys(keys.charAt(i)));
    }
    eq(expectedValue, cm.getValue());
    helpers.assertCursorAt(finalPos);
  }, { value: initialValue }));
}
(await testSubstituteConfirm('ex_substitute_confirm_emptydoc',
    '%s/x/b/c', '', '', '', makeCursor(0, 0)));
(await testSubstituteConfirm('ex_substitute_confirm_nomatch',
    '%s/x/b/c', 'ba a\nbab', 'ba a\nbab', '', makeCursor(0, 0)));
(await testSubstituteConfirm('ex_substitute_confirm_accept',
    '%s/a/b/cg', 'ba a\nbab', 'bb b\nbbb', 'yyy', makeCursor(1, 1)));
(await testSubstituteConfirm('ex_substitute_confirm_random_keys',
    '%s/a/b/cg', 'ba a\nbab', 'bb b\nbbb', 'ysdkywerty', makeCursor(1, 1)));
(await testSubstituteConfirm('ex_substitute_confirm_some',
    '%s/a/b/cg', 'ba a\nbab', 'bb a\nbbb', 'yny', makeCursor(1, 1)));
(await testSubstituteConfirm('ex_substitute_confirm_all',
    '%s/a/b/cg', 'ba a\nbab', 'bb b\nbbb', 'a', makeCursor(1, 1)));
(await testSubstituteConfirm('ex_substitute_confirm_accept_then_all',
    '%s/a/b/cg', 'ba a\nbab', 'bb b\nbbb', 'ya', makeCursor(1, 1)));
(await testSubstituteConfirm('ex_substitute_confirm_quit',
    '%s/a/b/cg', 'ba a\nbab', 'bb a\nbab', 'yq', makeCursor(0, 3)));
(await testSubstituteConfirm('ex_substitute_confirm_last',
    '%s/a/b/cg', 'ba a\nbab', 'bb b\nbab', 'yl', makeCursor(0, 3)));
(await testSubstituteConfirm('ex_substitute_confirm_oneline',
    '1s/a/b/cg', 'ba a\nbab', 'bb b\nbab', 'yl', makeCursor(0, 3)));
(await testSubstituteConfirm('ex_substitute_confirm_range_accept',
    '1,2s/a/b/cg', 'aa\na \na\na', 'bb\nb \na\na', 'yyy', makeCursor(1, 0)));
(await testSubstituteConfirm('ex_substitute_confirm_range_some',
    '1,3s/a/b/cg', 'aa\na \na\na', 'ba\nb \nb\na', 'ynyy', makeCursor(2, 0)));
(await testSubstituteConfirm('ex_substitute_confirm_range_all',
    '1,3s/a/b/cg', 'aa\na \na\na', 'bb\nb \nb\na', 'a', makeCursor(2, 0)));
(await testSubstituteConfirm('ex_substitute_confirm_range_last',
    '1,3s/a/b/cg', 'aa\na \na\na', 'bb\nb \na\na', 'yyl', makeCursor(1, 0)));
//:noh should clear highlighting of search-results but allow to resume search through n
(await testVim('ex_noh_clearSearchHighlight', async function(cm, vim, helpers) {
  is(!searchHighlighted(vim));
  (await helpers.doKeys('?', 'match', '\n'));
  is(searchHighlighted(vim));
  (await helpers.doEx('noh'));
  is(!searchHighlighted(vim));
  (await helpers.doKeys('n'));
  helpers.assertCursorAt(0, 11,'can\'t resume search after clearing highlighting');
}, { value: 'match nope match \n nope Match' }));
(await testVim('ex_yank', async function (cm, vim, helpers) {
  var curStart = makeCursor(3, 0);
  cm.setCursor(curStart);
  (await helpers.doEx('y'));
  var register = helpers.getRegisterController().getRegister();
  var line = cm.getLine(3);
  eq(line + '\n', register.toString());
}));
(await testVim('set_boolean', function(cm, vim, helpers) {
  CodeMirror.Vim.defineOption('testoption', true, 'boolean');
  // Test default value is set.
  is(CodeMirror.Vim.getOption('testoption'));
  // Test fail to set to non-boolean
  var result = CodeMirror.Vim.setOption('testoption', '5');
  is(result instanceof Error);
  // Test setOption
  CodeMirror.Vim.setOption('testoption', false);
  is(!CodeMirror.Vim.getOption('testoption'));
}));
(await testVim('ex_set_boolean', async function(cm, vim, helpers) {
  CodeMirror.Vim.defineOption('testoption', true, 'boolean');
  // Test default value is set.
  is(CodeMirror.Vim.getOption('testoption'));
  is(!cm.state.currentNotificationClose);
  // Test fail to set to non-boolean
  (await helpers.doEx('set testoption=22'));
  is(cm.state.currentNotificationClose);
  // Test setOption
  (await helpers.doEx('set notestoption'));
  is(!CodeMirror.Vim.getOption('testoption'));
  // Test toggle with !
  (await helpers.doEx('set notestoption!'));
  is(CodeMirror.Vim.getOption('testoption'));
  (await helpers.doEx('set notestoption!'));
  is(!CodeMirror.Vim.getOption('testoption'));
  (await helpers.doEx('set testoption!'));
  is(CodeMirror.Vim.getOption('testoption'));
  (await helpers.doEx('set testoption!'));
  is(!CodeMirror.Vim.getOption('testoption'));
}));
// Make sure that langmap option is properly defined and "=" does not break option value parsing
(await testVim('set_langmap', async function(cm, vim, helpers) {
  (await helpers.doEx('set langmap==j'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('='));
  helpers.assertCursorAt(1,0);
}));
(await testVim('set_string', function(cm, vim, helpers) {
  CodeMirror.Vim.defineOption('testoption', 'a', 'string');
  // Test default value is set.
  eq('a', CodeMirror.Vim.getOption('testoption'));
  // Test no fail to set non-string.
  var result = CodeMirror.Vim.setOption('testoption', true);
  is(!result);
  // Test fail to set 'notestoption'
  result = CodeMirror.Vim.setOption('notestoption', 'b');
  is(result instanceof Error);
  // Test setOption
  CodeMirror.Vim.setOption('testoption', 'c');
  eq('c', CodeMirror.Vim.getOption('testoption'));
}));
(await testVim('ex_set_string', async function(cm, vim, helpers) {
  CodeMirror.Vim.defineOption('testopt', 'a', 'string');
  // Test default value is set.
  eq('a', CodeMirror.Vim.getOption('testopt'));
  // Test fail to set 'notestopt'
  is(!cm.state.currentNotificationClose);
  (await helpers.doEx('set notestopt=b'));
  is(cm.state.currentNotificationClose);
  // Test setOption
  (await helpers.doEx('set testopt=c'));
  eq('c', CodeMirror.Vim.getOption('testopt'));
  (await helpers.doEx('set testopt=c'));
  eq('c', CodeMirror.Vim.getOption('testopt', cm)); //local || global
  eq('c', CodeMirror.Vim.getOption('testopt', cm, {scope: 'local'})); // local
  eq('c', CodeMirror.Vim.getOption('testopt', cm, {scope: 'global'})); // global
  eq('c', CodeMirror.Vim.getOption('testopt')); // global
  // Test setOption global
  (await helpers.doEx('setg testopt=d'));
  eq('c', CodeMirror.Vim.getOption('testopt', cm));
  eq('c', CodeMirror.Vim.getOption('testopt', cm, {scope: 'local'}));
  eq('d', CodeMirror.Vim.getOption('testopt', cm, {scope: 'global'}));
  eq('d', CodeMirror.Vim.getOption('testopt'));
  // Test setOption local
  (await helpers.doEx('setl testopt=e'));
  eq('e', CodeMirror.Vim.getOption('testopt', cm));
  eq('e', CodeMirror.Vim.getOption('testopt', cm, {scope: 'local'}));
  eq('d', CodeMirror.Vim.getOption('testopt', cm, {scope: 'global'}));
  eq('d', CodeMirror.Vim.getOption('testopt'));
}));
(await testVim('ex_set_callback', async function(cm, vim, helpers) {
  var global;

  function cb(val, cm, cfg) {
    if (val === undefined) {
      // Getter
      if (cm) {
        return cm._local;
      } else {
        return global;
      }
    } else {
      // Setter
      if (cm) {
        cm._local = val;
      } else {
        global = val;
      }
    }
  }

  CodeMirror.Vim.defineOption('testopt', 'a', 'string', cb);
  // Test default value is set.
  eq('a', CodeMirror.Vim.getOption('testopt'));
  // Test fail to set 'notestopt'
  is(!cm.state.currentNotificationClose);
  (await helpers.doEx('set notestopt=b'));
  is(cm.state.currentNotificationClose);
  // Test setOption (Identical to the string tests, but via callback instead)
  (await helpers.doEx('set testopt=c'));
  eq('c', CodeMirror.Vim.getOption('testopt', cm)); //local || global
  eq('c', CodeMirror.Vim.getOption('testopt', cm, {scope: 'local'})); // local
  eq('c', CodeMirror.Vim.getOption('testopt', cm, {scope: 'global'})); // global
  eq('c', CodeMirror.Vim.getOption('testopt')); // global
  // Test setOption global
  (await helpers.doEx('setg testopt=d'));
  eq('c', CodeMirror.Vim.getOption('testopt', cm));
  eq('c', CodeMirror.Vim.getOption('testopt', cm, {scope: 'local'}));
  eq('d', CodeMirror.Vim.getOption('testopt', cm, {scope: 'global'}));
  eq('d', CodeMirror.Vim.getOption('testopt'));
  // Test setOption local
  (await helpers.doEx('setl testopt=e'));
  eq('e', CodeMirror.Vim.getOption('testopt', cm));
  eq('e', CodeMirror.Vim.getOption('testopt', cm, {scope: 'local'}));
  eq('d', CodeMirror.Vim.getOption('testopt', cm, {scope: 'global'}));
  eq('d', CodeMirror.Vim.getOption('testopt'));
}));
(await testVim('ex_set_filetype', async function(cm, vim, helpers) {
  if (isOldCodeMirror) CodeMirror.defineMode('test_mode', function() {
    return {token: function(stream) {
      stream.match(/^\s+|^\S+/);
    }};
  });
  if (isOldCodeMirror) CodeMirror.defineMode('test_mode_2', function() {
    return {token: function(stream) {
      stream.match(/^\s+|^\S+/);
    }};
  });
  // Test mode is set.
  (await helpers.doEx('set filetype=test_mode'));
  eq('test_mode', cm.getMode().name);
  // Test 'ft' alias also sets mode.
  (await helpers.doEx('set ft=test_mode_2'));
  eq('test_mode_2', cm.getMode().name);
}));
(await testVim('ex_set_filetype_null', async function(cm, vim, helpers) {
  if (isOldCodeMirror) CodeMirror.defineMode('test_mode', function() {
    return {token: function(stream) {
      stream.match(/^\s+|^\S+/);
    }};
  });
  cm.setOption('mode', 'test_mode');
  // Test mode is set to null.
  (await helpers.doEx('set filetype='));
  eq('null', cm.getMode().name);
}));

(await testVim('map_prompt', async function(cm, vim, helpers) {
  is(!searchHighlighted(vim));

  (await helpers.doKeys('/a\n'));
  (await helpers.doKeys('i'));
  is(searchHighlighted(vim));
  (await helpers.doKeys('<Esc>'));
  (await helpers.doEx('nohl'));
  is(!searchHighlighted(vim));
  helpers.assertCursorAt(1, 2);

  (await helpers.doEx('nnoremap i :nohl<CR>i<space>xx<lt>'));
  (await helpers.doEx('map :sayhi ihi<Esc>'));
  (await helpers.doEx('map j :sayhi<CR>/<up><up>b'));

  (await helpers.doKeys('/1\n'));
  helpers.assertCursorAt(1, 1);

  (await helpers.doKeys('j'));
  eq(cm.getWrapperElement().querySelector("input").value, "ab");
  (await helpers.doKeys('<CR>'));
  is(searchHighlighted(vim));
  (await helpers.doKeys('i'));
  is(!searchHighlighted(vim));

  eq(cm.getValue(), ' 0 xyz\n hi1  xx<abc \n 2 abc');

  (await helpers.doKeys('mapclear'));
}, { value: ' 0 xyz\n 1 abc \n 2 abc' }));
(await testVim('mapclear', async function(cm, vim, helpers) {
  CodeMirror.Vim.map('w', 'l');
  cm.setCursor(0, 0);
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('w'));
  helpers.assertCursorAt(0, 1);
  CodeMirror.Vim.mapclear('visual');
  (await helpers.doKeys('v', 'w', 'v'));
  helpers.assertCursorAt(0, 4);
  (await helpers.doKeys('w'));
  helpers.assertCursorAt(0, 5);
}, { value: 'abc abc' }));
(await testVim('mapclear_context', async function(cm, vim, helpers) {
  CodeMirror.Vim.map('w', 'l', 'normal');
  cm.setCursor(0, 0);
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('w'));
  helpers.assertCursorAt(0, 1);
  CodeMirror.Vim.mapclear('normal');
  (await helpers.doKeys('w'));
  helpers.assertCursorAt(0, 4);
}, { value: 'abc abc' }));

(await testVim('ex_map_key2key', async function(cm, vim, helpers) {
  (await helpers.doEx('map a x'));
  (await helpers.doKeys('a'));
  helpers.assertCursorAt(0, 0);
  eq('bc', cm.getValue());
}, { value: 'abc' }));
(await testVim('ex_unmap_key2key', async function(cm, vim, helpers) {
  (await helpers.doEx('map a x'));
  (await helpers.doEx('unmap a'));
  (await helpers.doKeys('a'));
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'abc' }));
(await testVim('ex_unmap_key2key_does_not_remove_default', async function(cm, vim, helpers) {
  (await helpers.doEx('unmap a'));
  is(/No such mapping: unmap a/.test(helpers.getNotificationText()));
  (await helpers.doKeys('a'));
  eq('vim-insert', cm.getOption('keyMap'));
}, { value: 'abc' }));
(await testVim('ex_map_key2key_to_colon', async function(cm, vim, helpers) {
  (await helpers.doEx('map ; :'));
  var dialogOpened = false;
  cm.openDialog = function() {
    dialogOpened = true;
  };
  (await helpers.doKeys(';'));
  eq(dialogOpened, true);
}));
(await testVim('ex_map_ex2key:', async function(cm, vim, helpers) {
  (await helpers.doEx('map :del x'));
  (await helpers.doEx('del'));
  helpers.assertCursorAt(0, 0);
  eq('bc', cm.getValue());
}, { value: 'abc' }));
(await testVim('ex_map_ex2ex', async function(cm, vim, helpers) {
  (await helpers.doEx('map :del :w'));
  var tmp = CodeMirror.commands.save;
  var written = false;
  var actualCm;
  CodeMirror.commands.save = function(cm) {
    written = true;
    actualCm = cm;
  };
  (await helpers.doEx('del'));
  CodeMirror.commands.save = tmp;
  eq(written, true);
  eq(actualCm, cm);
}));
(await testVim('ex_map_key2ex', async function(cm, vim, helpers) {
  (await helpers.doEx('map a :w<CR>'));
  var tmp = CodeMirror.commands.save;
  var written = false;
  var actualCm;
  CodeMirror.commands.save = function(cm) {
    written = true;
    actualCm = cm;
  };
  (await helpers.doKeys('a'));
  CodeMirror.commands.save = tmp;
  eq(written, true);
  eq(actualCm, cm);
}));
(await testVim('ex_map_key2key_visual_api', async function(cm, vim, helpers) {
  CodeMirror.Vim.map('b', ':w<CR>', 'visual');
  var tmp = CodeMirror.commands.save;
  var written = false;
  var actualCm;
  CodeMirror.commands.save = function(cm) {
    written = true;
    actualCm = cm;
  };
  // Mapping should not work in normal mode.
  (await helpers.doKeys('b'));
  eq(written, false);
  // Mapping should work in visual mode.
  (await helpers.doKeys('v', 'b'));
  eq(written, true);
  eq(actualCm, cm);

  CodeMirror.commands.save = tmp;
}));
(await testVim('ex_omap', async function(cm, vim, helpers) {
  (await helpers.doKeys('0', 'w', 'd', 'w'));
  eq(cm.getValue(), 'hello world');
  (await helpers.doKeys('u'));
  (await helpers.doKeys(':', 'omap w $\n'));
  (await helpers.doKeys( '0', 'w'));
  helpers.assertCursorAt(0, 6);
  (await helpers.doKeys('d', 'w'));
  eq(cm.getValue(), 'hello ');
}, {value: 'hello unfair world'}));
(await testVim('ex_nmap', async function(cm, vim, helpers) {
  cm.setCursor(0, 3);
  (await helpers.doEx('nmap k gj'));
  (await helpers.doKeys('k'));
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('d', 'k'));
  eq(cm.getValue(), 'world');
  (await helpers.doKeys('u'));
  cm.setCursor(1, 3);
  (await helpers.doEx('map k gj'));
  (await helpers.doKeys('d', 'k'));
  eq(cm.getValue(), 'hello\nunfld');
  helpers.assertCursorAt(1, 3);
  (await helpers.doKeys('<Up>'));
  helpers.assertCursorAt(0, 3);
}, {value: 'hello\nunfair\nworld'}));
(await testVim('ex_imap', async function(cm, vim, helpers) {
  CodeMirror.Vim.map('jk', '<Esc>', 'insert');
  (await helpers.doKeys('i'));
  is(vim.insertMode);
  (await helpers.doKeys('j', 'k'));
  is(!vim.insertMode);
  cm.setCursor(0, 1);
  CodeMirror.Vim.map('jj', '<Esc>', 'insert');
  (await helpers.doKeys('<C-v>', '2', 'j', 'l', 'c'));
  (await helpers.doKeys('f', 'o'));
  eq('1fo4\n5fo8\nafodefg', cm.getValue());
  (await helpers.doKeys('j', 'j'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('.'));
  eq('foo4\nfoo8\nfoodefg', cm.getValue());
  (await helpers.doKeys('R', 'x', 'j', 'j'));
  eq('xoo4\nfoo8\nfoodefg', cm.getValue());
  (await helpers.doKeys('i'));
  cm.setSelections([
    {head: makeCursor(0, 0), anchor: makeCursor(0, 1)},
    {head: makeCursor(1, 0), anchor: makeCursor(1, 2)}
  ]);
  (await helpers.doKeys('j'));
  eq('joo4\njo8\nfoodefg', cm.getValue());
  (await helpers.doKeys('j'));
  eq('xoo4\nfoo8\nfoodefg', cm.getValue());
  
  if (cm.forEachSelection) {
    cm.setSelections([
      {head: makeCursor(0, 2), anchor: makeCursor(0, 2)},
      {head: makeCursor(1, 2), anchor: makeCursor(1, 2)},
      {head: makeCursor(2, 4), anchor: makeCursor(2, 4)}
    ]);
    (await helpers.doKeys('R', 'x'));
    eq('xox4\nfox8\nfoodxfg', cm.getValue());
    (await helpers.doKeys('j'));
    eq('xoxj\nfoxj\nfoodxjg', cm.getValue());
    (await helpers.doKeys('k'));
    eq('xox4\nfox8\nfoodxfg', cm.getValue());
    eq(3, cm.listSelections().length);
  }

  cm.setValue('1\n2');
  (await helpers.doKeys('gg', 'dd'));
  (await helpers.doEx('imap a <C-c>'));
  (await helpers.doKeys('i', 'x', 'a', 'p'));
  eq('x2\n1', cm.getValue());
}, { value: '1234\n5678\nabcdefg' }));
(await testVim('ex_unmap_api', async function(cm, vim, helpers) {
  CodeMirror.Vim.map('<Alt-X>', 'gg', 'normal');
  is((await CodeMirror.Vim.handleKey(cm, "<Alt-X>", "normal")), "Alt-X key is mapped");
  CodeMirror.Vim.unmap("<Alt-X>", "normal");
  is(!(await CodeMirror.Vim.handleKey(cm, "<Alt-X>", "normal")), "Alt-X key is unmapped");
}));
// Testing registration of functions as ex-commands and mapping to <Key>-keys
(await testVim('ex_api_test', async function(cm, vim, helpers) {
  var res=false;
  var val='from';
  CodeMirror.Vim.defineEx('extest','ext',function(cm,params){
    if(params.args)val=params.args[0];
    else res=true;
  });
  (await helpers.doEx(':ext to'));
  eq(val,'to','Defining ex-command failed');
  CodeMirror.Vim.map('<C-CR><Space>',':ext<CR>');
  (await helpers.doKeys('<C-CR>','<Space>'));
  is(res,'Mapping to key failed');
}));
// Testing ex-commands with non-alpha names.
(await testVim('ex_special_names', async function(cm, vim, helpers) {
  var ran,val;
  var cmds = ['!','!!','#','&','<','=','>','@','@@','~','regtest1','RT2'];
  (await forEach(cmds, async function(name){
    CodeMirror.Vim.defineEx(name,'',function(cm,params){
      ran=params.commandName;
      val=params.argString;
    });
    (await helpers.doEx(':'+name));
    eq(ran,name,'Running ex-command failed');
    (await helpers.doEx(':'+name+' x'));
    eq(val,' x','Running ex-command with param failed: '+name);
    if(/^\W+$/.test(name)){
      (await helpers.doEx(':'+name+'y'));
      eq(val,'y','Running ex-command with param failed: '+name);
    }
    else{
      (await helpers.doEx(':'+name+'-y'));
      eq(val,'-y','Running ex-command with param failed: '+name);
    }
    if(name!=='!'){
      (await helpers.doEx(':'+name+'!'));
      eq(ran,name,'Running ex-command with bang failed');
      eq(val,'!','Running ex-command with bang failed: '+name);
      (await helpers.doEx(':'+name+'!z'));
      eq(ran,name,'Running ex-command with bang & param failed');
      eq(val,'!z','Running ex-command with bang & param failed: '+name);
    }
  }));
}));
// For now, this test needs to be last because it messes up : for future tests.
(await testVim('ex_map_key2key_from_colon', async function(cm, vim, helpers) {
  (await helpers.doEx('map : x'));
  (await helpers.doKeys(':'));
  helpers.assertCursorAt(0, 0);
  eq('bc', cm.getValue());
}, { value: 'abc' }));

(await testVim('map <Esc> in normal mode', async function(cm, vim, helpers) {
  CodeMirror.Vim.noremap('<Esc>', 'i', 'normal');
  (await helpers.doKeys('<Esc>'));
  is(vim.insertMode, "Didn't switch to insert mode.");
  (await helpers.doKeys('<Esc>'));
  is(!vim.insertMode, "Didn't switch to normal mode.");
}));

(await testVim('noremap', async function(cm, vim, helpers) {
  (await helpers.doEx('noremap ; l'));
  (await helpers.doEx('map l $'));
  (await helpers.doEx('map q l'));
  (await helpers.doKeys('l'));
  helpers.assertCursorAt(0, 4);
  cm.setCursor(0, 0);
  (await helpers.doKeys('q'));
  helpers.assertCursorAt(0, 4);
  cm.setCursor(0, 0);
  eq('wOrd1', cm.getValue());
  // Mapping should work in normal mode.
  (await helpers.doKeys(';', 'r', '1'));
  eq('w1rd1', cm.getValue());
  // Mapping will not work in insert mode because of no current fallback
  // keyToKey mapping support.
  (await helpers.doKeys('i', ';', '<Esc>'));
  eq('w;1rd1', cm.getValue());
  // unmap all mappings
  (await helpers.doEx('mapclear'));
  cm.setCursor(0, 0);
  (await helpers.doKeys('l'));
  helpers.assertCursorAt(0, 1);
  // map key to itself
  (await helpers.doKeys('x', 'p', 'l'));
  eq('w1;rd1', cm.getValue());
  (await helpers.doEx('noremap x "_x'));
  (await helpers.doKeys('x', 'p'));
  eq('w1;d;1', cm.getValue());
  (await helpers.doEx('mapclear'));
}, { value: 'wOrd1' }));
// noremap should capture all mappings of the rhs 
(await testVim('noremap_all_mappings', async function(cm, vim, helpers) {
  // mapping to 'u' should undo in normal mode and lowercase in visual mode
  CodeMirror.Vim.noremap('a', 'u');
  (await helpers.doKeys('y', 'y', 'p'));
  eq('HeY\nHeY', cm.getValue());
  // undo
  (await helpers.doKeys('a'));
  eq('HeY', cm.getValue());
  // lowercase
  (await helpers.doKeys('V', 'a'));
  eq('hey', cm.getValue());
}, { value: 'HeY' }));
(await testVim('noremap_swap', async function(cm, vim, helpers) {
  CodeMirror.Vim.noremap('i', 'a', 'normal');
  CodeMirror.Vim.noremap('a', 'i', 'normal');
  cm.setCursor(0, 0);
  // 'a' should act like 'i'.
  (await helpers.doKeys('a'));
  eqCursorPos(new Pos(0, 0), cm.getCursor());
  // ...and 'i' should act like 'a'.
  (await helpers.doKeys('<Esc>', 'i'));
  eqCursorPos(new Pos(0, 1), cm.getCursor());
}, { value: 'foo' }));
(await testVim('noremap_map_interaction', async function(cm, vim, helpers) {
  // noremap should clobber map
  CodeMirror.Vim.map(';', 'l');
  CodeMirror.Vim.noremap(';', 'l');
  CodeMirror.Vim.map('l', 'j');
  cm.setCursor(0, 0);
  (await helpers.doKeys(';'));
  eqCursorPos(new Pos(0, 1), cm.getCursor());
  (await helpers.doKeys('l'));
  eqCursorPos(new Pos(1, 1), cm.getCursor());
  // map should be able to point to a noremap
  CodeMirror.Vim.map('m', ';');
  (await helpers.doKeys('m'));
  eqCursorPos(new Pos(1, 2), cm.getCursor());
}, { value: 'wOrd1\nwOrd2' }));
(await testVim('noremap_map_interaction2', async function(cm, vim, helpers) {
  // map should point to the most recent noremap
  CodeMirror.Vim.noremap(';', 'l');
  CodeMirror.Vim.map('m', ';');
  CodeMirror.Vim.noremap(';', 'h');
  cm.setCursor(0, 0);
  (await helpers.doKeys('l'));
  eqCursorPos(new Pos(0, 1), cm.getCursor());
  (await helpers.doKeys('m'));
  eqCursorPos(new Pos(0, 0), cm.getCursor());
}, { value: 'wOrd1\nwOrd2' }));

(await testVim('gq_and_gw', async function(cm, vim, helpers) {
  cm.setValue(
    "1\n2\nhello world\n"
    + "xxx ".repeat(20)
    + "\nyyy"
    + "\n\nnext\nparagraph"
  );
  cm.setCursor(2,5);
  (await helpers.doKeys("gqgq"));
  helpers.assertCursorAt(2, 0);
  eq(cm.getLine(2), "hello world");

  (await helpers.doKeys("gqj"));
  helpers.assertCursorAt(3, 0);
  eq(cm.getLine(3), "xxx xxx xxx ");

  (await helpers.doKeys("gq}"));
  helpers.assertCursorAt(4, 0);
  eq(cm.getLine(3), "xxx xxx xxx yyy");

  (await helpers.doKeys("gqG"));
  (await helpers.doKeys("gqgg"));
  (await helpers.doKeys(":set tw=15\n"));

  (await helpers.doKeys("gg", "V", "gq"));
  eq(cm.getLine(0), "1 2 hello world");
  eq(cm.getLine(5), "xxx xxx xxx xxx yyy");
  (await helpers.doKeys(":6\n"));
  (await helpers.doKeys("gqq"));

  eq(cm.getLine(6), "yyy");
}, { value: 'wOrd1\nwOrd2' }));

(await testVim('updateStatus', async function(cm, vim, helpers) {
  var keys = '';
  CodeMirror.on(cm, 'vim-keypress', function(key) {
    keys = keys + key;
  });
  CodeMirror.on(cm, 'vim-command-done', function(e) {
    keys = '';
  });
  (await helpers.doKeys('d'));
  eq(keys, 'd');
  (await helpers.doKeys('/', 'match', '\n'));
  eq(keys, '');
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('d'));
  eq(keys, 'd');
  (await helpers.doKeys('/', '<Esc>'));
  eq(keys, '');
  (await helpers.doKeys('d'));
  eq(keys, 'd');
  (await helpers.doKeys(':'));
  eq(keys, 'd:');
  (await helpers.doKeys('<Esc>'));
  eq(keys, '');
}, { value: 'text match match \n next' }));

// Test event handlers
(await testVim('beforeSelectionChange', function(cm, vim, helpers) {
  cm.setCursor(0, 100);
  eqCursorPos(cm.getCursor('head'), cm.getCursor('anchor'));
}, { value: 'abc' }));

(await testVim('increment_binary', async function(cm, vim, helpers) {
  cm.setCursor(0, 4);
  (await helpers.doKeys('<C-a>'));
  eq('0b001', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0b010', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0b001', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0b000', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-a>'));
  eq('0b001', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0b010', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0b001', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0b000', cm.getValue());
}, { value: '0b000' }));

(await testVim('increment_octal', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('<C-a>'));
  eq('001', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('002', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('003', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('004', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('005', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('006', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('007', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('010', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('007', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('006', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('005', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('004', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('003', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('002', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('001', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('000', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-a>'));
  eq('001', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('002', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('001', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('000', cm.getValue());
}, { value: '000' }));

(await testVim('increment_decimal', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('<C-a>'));
  eq('101', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('102', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('103', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('104', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('105', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('106', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('107', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('108', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('109', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('110', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('109', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('108', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('107', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('106', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('105', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('104', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('103', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('102', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('101', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('100', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-a>'));
  eq('101', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('102', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('101', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('100', cm.getValue());
}, { value: '100' }));

(await testVim('increment_decimal_single_zero', async function(cm, vim, helpers) {
  (await helpers.doKeys('<C-a>'));
  eq('1', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('2', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('3', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('4', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('5', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('6', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('7', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('8', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('9', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('10', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('9', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('8', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('7', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('6', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('5', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('4', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('3', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('2', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('1', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-a>'));
  eq('1', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('2', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('1', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0', cm.getValue());
}, { value: '0' }));

(await testVim('increment_hexadecimal', async function(cm, vim, helpers) {
  cm.setCursor(0, 2);
  (await helpers.doKeys('<C-a>'));
  eq('0x1', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x2', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x3', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x4', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x5', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x6', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x7', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x8', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x9', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0xa', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0xb', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0xc', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0xd', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0xe', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0xf', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x10', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x0f', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x0e', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x0d', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x0c', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x0b', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x0a', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x09', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x08', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x07', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x06', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x05', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x04', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x03', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x02', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x01', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x00', cm.getValue());
  cm.setCursor(0, 0);
  (await helpers.doKeys('<C-a>'));
  eq('0x01', cm.getValue());
  (await helpers.doKeys('<C-a>'));
  eq('0x02', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x01', cm.getValue());
  (await helpers.doKeys('<C-x>'));
  eq('0x00', cm.getValue());
}, { value: '0x0' }));

(await testVim('option_key_on_mac', async function(cm, vim, helpers) {
  CodeMirror.isMac = true;
  helpers.assertCursorAt(0, 0);
  typeKey.optionTextInput('9', '}');
  helpers.assertCursorAt(3, 0);
  typeKey.optionTextInput('8', '{');
  helpers.assertCursorAt(0, 0);

  typeKey.utfTextInput('d', 'д');
  typeKey.utfTextInput('l', 'л');
  typeKey.utfTextInput('d', 'д');
  typeKey.utfTextInput('G', 'Г');
  eq('', cm.getValue());
  (await helpers.doKeys('"-p'));
  eq('0', cm.getValue());
  //TODO bug in paste
  (await helpers.doKeys('l'));
  helpers.assertCursorAt(0, 0);

  // map A-v
  (await helpers.doEx(':map <A-v> i<lt>A-v><Esc>'));

  // verify that replace still works
  typeKey.utfTextInput('r', 'Ռ');
  typeKey.optionTextInput('v', '√');
  eq('√', cm.getValue());

  typeKey.optionTextInput('v', '√');
  eq('<A-v>√', cm.getValue());
  
  (await helpers.doEx(':map √ i√G<Esc>'));
  typeKey.optionTextInput('v', '√');
  eq('<A-v√G>√', cm.getValue());

  (await helpers.doEx(':unmap √'));
  typeKey.optionTextInput('v', '√');
  eq('<A-v√<A-v>G>√', cm.getValue());

  (await helpers.doEx(':unmap <A-v>'));
  typeKey.optionTextInput('v', '√');
  eq('<A-v√<A-v>G>√', cm.getValue());

  CodeMirror.isMac = false;
}, { value: '0\n1\n2\n\n\n3\n4\n' }));


!isOldCodeMirror && (await testVim('<C-c>copy', async function(cm, vim, helpers) {
  (await helpers.doKeys('v', 'e'));
  is(vim.visualMode, "clipboard step 1");
  typeKey.clipboard.$data = '';
  (await helpers.doKeys('<C-c>'));
  eq(typeKey.clipboard.$data, 'hello');
  await delay(0);
  is(!vim.visualMode, "clipboard step 2");
  (await helpers.doKeys('w', 'i', CodeMirror.platformMac ? 'Shift-Alt-Right' : '<S-C-Right>'));
  is(vim.insertMode, "clipboard step 3");
  (await helpers.doKeys('<C-c>'));
  is(vim.insertMode, "clipboard step 4");
  eq(typeKey.clipboard.$data, 'world');
  // Each awaited key settles the asynchronous copy cleanup, as distinct browser
  // key events do. The next Ctrl-C now has no selection and leaves insert mode.
  await delay(0);
  is(vim.insertMode, "clipboard step 5");
  (await helpers.doKeys('<C-c>'));
  is(!vim.insertMode, "clipboard step 6");
}, { value: 'hello world' }));

(await testVim('<C-r>_insert_mode', async function(cm, vim, helpers) {
  helpers.assertCursorAt(0, 0);
  (await helpers.doKeys('d', 'w', 'A'));
  (await helpers.doKeys('<C-r>', '-'));
  eq('456 123 ', cm.getValue());
}, { value: '123 456 ' }));

//
//  test correct langmap function
//
const dvorakLangmap = "'q,\\,w,.e,pr,yt,fy,gu,ci,ro,lp,/[,=],aa,os,ed,uf,ig,dh,hj,tk,nl,s\\;,-',\\;z,qx,jc,kv,xb,bn,mm,w\\,,v.,z/,[-,]=,\"Q,<W,>E,PR,YT,FY,GU,CI,RO,LP,?{,+},AA,OS,ED,UF,IG,DH,HJ,TK,NL,S:,_\",:Z,QX,JC,KV,XB,BN,MM,W<,V>,Z?";
// this test makes sure that remapping works on an example binding
isOldCodeMirror || (await testVim('langmap_dd', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap);

  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(0, 0),
    new Pos(1, 0));
  var expectedLineCount = cm.lineCount() - 1;

  (await helpers.doKeys('e', 'e'));

  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, lines[1].textStart);
}));
// this test serves two functions:
// - make sure that "dd" is **not** interpreted as delete line (correct unmapping)
// - make sure that "dd" **is** interpreted as move left twice (correct mapping)
isOldCodeMirror || (await testVim('langmap_hh', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap);

  const startPos = word1.end;
  const endPos = offsetCursor(word1.end, 0, -2);

  cm.setCursor(startPos);
  (await helpers.doKeys('d', 'd'));
  helpers.assertCursorAt(endPos);
}));
// this test serves two functions:
// - make sure tha the register is properly remapped so that special registers aren't mixed up
// - make sure that recording and replaying macros works without "double remapping"
isOldCodeMirror || (await testVim('langmap_qqddq@q', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap);

  cm.setCursor(0, 3);
  var expectedBuffer = cm.getRange(new Pos(1, 0),
    new Pos(2, 0));
  var expectedLineCount = cm.lineCount() - 2;

  (await helpers.doKeys('\'\'', 'e', 'e', '\'', '@\''));

  eq(expectedLineCount, cm.lineCount());
  var register = helpers.getRegisterController().getRegister();
  eq(expectedBuffer, register.toString());
  is(register.linewise);
  helpers.assertCursorAt(0, lines[2].textStart);
}));
// this test makes sure that <character> directives are interpreted literally
isOldCodeMirror || (await testVim('langmap_fd', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap);

  cm.setCursor(0, 0);
  (await helpers.doKeys('u', 'd'));
  helpers.assertCursorAt(0, 4);
}));
// this test makes sure that markers work properly
isOldCodeMirror || (await testVim('langmap_mark', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap);

  cm.setCursor(2, 2);
  (await helpers.doKeys('m', '\''));
  cm.setCursor(0, 0);
  (await helpers.doKeys('`', '\''));
  helpers.assertCursorAt(2, 2);
  cm.setCursor(2, 0);
  cm.replaceRange('   h', cm.getCursor());
  cm.setCursor(0, 0);
  (await helpers.doKeys('-', '\''));
  helpers.assertCursorAt(2, 3);
}));
// check that ctrl remapping works properly
isOldCodeMirror || (await testVim('langmap_visual_block', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap);

  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-k>', '2', 'h', 'n', 'n', 'n', 'j'));
  (await helpers.doKeys('hello'));
  eq('1hello\n5hello\nahellofg', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(2, 3);
  (await helpers.doKeys('<C-k>', '2', 't', 'd', 'J'));
  (await helpers.doKeys('world'));
  eq('1hworld\n5hworld\nahworld', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));
// check that ctrl remapping can be disabled
isOldCodeMirror || (await testVim('langmap_visual_block_no_ctrl_remap', async function(cm, vim, helpers) {
  CodeMirror.Vim.langmap(dvorakLangmap, false);

  cm.setCursor(0, 1);
  (await helpers.doKeys('<C-v>', '2', 'h', 'n', 'n', 'n', 'j'));
  (await helpers.doKeys('hello'));
  eq('1hello\n5hello\nahellofg', cm.getValue());
  (await helpers.doKeys('<Esc>'));
  cm.setCursor(2, 3);
  (await helpers.doKeys('<C-v>', '2', 't', 'd', 'J'));
  (await helpers.doKeys('world'));
  eq('1hworld\n5hworld\nahworld', cm.getValue());
}, {value: '1234\n5678\nabcdefg'}));

(await testVim('rendered_cursor_position_cm6', async function(cm, vim, helpers) {
  if (!cm.cm6) return;
  cm.setCursor(0, 1);
  (await helpers.doKeys('V'));
  function testCursorPosition(line, ch) {
    cm.refresh();
    var coords = cm.charCoords({line, ch});
    var cursorRect = cm.getWrapperElement().querySelector(".cm-fat-cursor").getBoundingClientRect();
    var contentRect = cm.getInputField().getBoundingClientRect();

    is(Math.abs(coords.top - (cursorRect.top - contentRect.top)) < 2);
    is(Math.abs(coords.left - (cursorRect.left - contentRect.left)) < 2);
  }
  testCursorPosition(0, 4);
  (await helpers.doKeys('j'));
  testCursorPosition(1, 0);
  (await helpers.doKeys('j'));
  testCursorPosition(2, 0);
  (await helpers.doKeys('j'));
  testCursorPosition(3, 4);

}, {value: '1234\n\n\n5678\nabcdefg'}));



async function delay(t) {
  return await new Promise(resolve => setTimeout(resolve, t));
}

}

var typeKey = function() {
  var keyCodeToKey = {};
  var keyCodeToCode = {};

  var alias = {};
  alias.Ctrl = "Control";
  alias.Option = "Alt";
  alias.Cmd = alias.Super = alias.Meta = "Command";

  var controlKeys = {
    Shift: 16, Control: 17, Alt: 18, Meta: 224, Command: 224,
    Backspace:8, Tab:9, Return: 13, Enter: 13,
    Pause: 19, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    Left: 37, Up: 38, Right: 39, Down: 40, Insert: 45, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  };
  var shiftedKeys = {};
  var printableKeys = {};
  var specialKeys = {
    Backquote: [192, "`", "~"], Minus: [189, "-", "_"], Equal: [187, "=", "+"],
    BracketLeft: [219, "[", "{"], Backslash: [220, "\\", "|"], BracketRight: [221, "]", "}"],
    Semicolon: [186, ";", ":"], Quote: [222, "'", '"'], Comma: [188, ",", "<"],
    Period: [190, ".", ">"], Slash: [191, "/", "?"], Space: [32, " ", " "], NumpadAdd: [107, "+"],
    NumpadDecimal: [110, "."], NumpadSubtract: [109, "-"], NumpadDivide: [111, "/"], NumpadMultiply: [106, "*"]
  };
  for (var i in specialKeys) {
    var key = specialKeys[i];
    printableKeys[i] = printableKeys[key[1]] = shiftedKeys[key[2]] = key[0];
    keyCodeToCode[key[0]] = i;
    keyCodeToKey[key[0]] = key[1];
    keyCodeToKey["s-" + key[0]] = key[2];
  }
  for (var i = 0; i < 10; i++) {
    var shifted = "!@#$%^&*()"[i];
    printableKeys[i] = shiftedKeys[shifted] = 48 + i;
    keyCodeToCode[48 + i] = "Digit" + i;
    keyCodeToKey[48 + i] = i.toString();
    keyCodeToKey["s-" + (48 + i)] = shifted;
  }
  for (var i = 65; i < 91; i++) {
    var chr = String.fromCharCode(i + 32);
    printableKeys[chr] = shiftedKeys[chr.toUpperCase()] = i;
    keyCodeToCode[i] = "Key" + chr.toUpperCase();
    keyCodeToKey[i] = chr;
    keyCodeToKey["s-" + i] = chr.toUpperCase();
  }
  for (var i = 1; i < 13; i++) {
    controlKeys["F" + i] = 111 + i;
  }

  for (var i in controlKeys) {
    keyCodeToKey[controlKeys[i]] = i;
    keyCodeToCode[controlKeys[i]] = i;
  }
  controlKeys["\t"] = controlKeys.Tab;
  controlKeys["\n"] = controlKeys.Return;
  controlKeys.Del = controlKeys.Delete;
  controlKeys.Esc = controlKeys.Escape;
  controlKeys.Ins = controlKeys.Insert;

  var shift = false;
  var ctrl = false;
  var meta = false;
  var alt = false;
  function reset() {
    shift = ctrl = meta = alt = false;
  }
  function updateModifierStates(keyCode) {
    if (keyCode == controlKeys.Shift)
      return shift = true;
    if (keyCode == controlKeys.Control)
      return ctrl = true;
    if (keyCode == controlKeys.Meta)
      return meta = true;
    if (keyCode == controlKeys.Alt)
      return alt = true;
  }

  function sendKey(letter, options) {
    var keyCode = controlKeys[letter] || printableKeys[letter] || shiftedKeys[letter];
    var isModifier = updateModifierStates(keyCode);

    var text = letter;
    var isTextInput = true;
    if (ctrl || alt || meta) {
      isTextInput = false;
    } else if (controlKeys[letter]) {
        if (keyCode == controlKeys.Return) {
            text = "\n";
            isTextInput = true;
        } else {
            isTextInput = false;
        }
    } else if (shift) {
      text = text.toUpperCase();
    }

    if (keyCodeToKey[keyCode] != text && keyCodeToKey["s-" + keyCode] == text) {
      shift = true;
    }
    var key = keyCodeToKey[(shift ? "s-" : "") + keyCode];
    
    if (options && options.text) {
      alt = options.altKey;
      text = key = options.text;
      isTextInput = true;
    }

    var target = document.activeElement;
    var prevented = emit("keydown", true);
    if (isModifier) return;
    if (!prevented && isTextInput) prevented = emit("keypress", true);
    if (!prevented && ctrl && !alt && !meta && letter == "c") emitClipboard("copy");
    if (!prevented) updateTextInput();
    emit("keyup", true);

    function emitClipboard(eventType) {
      var data = {bubbles: true, cancelable:true};
      var event = new KeyboardEvent(eventType, data);
      event.clipboardData = {
        setData: function(mime, text) {
          type.clipboard.$data = text;
        },
        getData: function() {
          return type.clipboard.$data;
        },
        clearData: function() {},
      };
      target.dispatchEvent(event);
    }
    function emit(type, bubbles) {
      var el = document.activeElement;
      var data = {bubbles: bubbles, cancelable:true};
      data.charCode = text.charCodeAt(0);
      data.keyCode = type == "keypress" ? data.charCode : keyCode;
      data.which = data.keyCode;
      data.shiftKey = shift || (shiftedKeys[text] && !printableKeys[text]);
      data.ctrlKey = ctrl;
      data.altKey = alt;
      data.metaKey = meta;
      data.key = key;
      data.code = keyCodeToCode[keyCode];
      var event = new KeyboardEvent(type, data);

      var el = document.activeElement;
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }
    function updateTextInput() {
      if (!isTextInput && keyCode == controlKeys.Return) {
        text = "\n";
      }
      if (target._handleInputEventForTest) {
        if (!isTextInput) return;
        return target._handleInputEventForTest(text);
      }
      var isTextarea = "selectionStart" in target && typeof target.value == "string";
      if (!isTextarea) return;

      var start = target.selectionStart;
      var end = target.selectionEnd;
      var value = target.value;

      if (!isTextInput) {
        if (keyCode == controlKeys.Backspace) {
          if (start != end) start = Math.max(start - 1, 0);
        } else if (keyCode == controlKeys.Delete) {
          if (start != end) end = Math.min(end + 1, value.length);
        } else {
          return;
        }
      }
      var newValue = value.slice(0, start) + text + value.slice(end);
      var newStart = start + text.length;
      var newEnd = newStart;
      if (newValue != value || newStart != start || newEnd != end) {
        target.value = newValue;
        target.setSelectionRange(newStart, newEnd);
        emit("input", false);
      }
    }
  }

  function type() {
    var keys = Array.prototype.slice.call(arguments);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (Array.isArray(key)) {
        type.apply(null, key);
        continue;
      }
      reset();
      if (key.length > 1) {
        var isKeyName = controlKeys[key] || printableKeys[key] || shiftedKeys[key];
        if (!isKeyName) {
          var parts = key.split("-");
          var modifiers = parts.slice(0, parts.length - 1).map(function(part) {
            return controlKeys[alias[part] || part];
          });
          var isValid = modifiers.length && modifiers.every(updateModifierStates);
          if (!isValid) {
            type.apply(null, key.split(""));
            continue;
          }
          key = parts.pop();
          parts.forEach(function(part) {
            var keyCode = controlKeys[part];
            updateModifierStates(keyCode);
          });
        }
      }
      sendKey(key);
    }
  }

  // emulates option-9 inputting } on mac swiss keyboard
  type.optionTextInput = function(letter, altText) {
    reset();
    sendKey(letter, {text: altText, altKey: true});
  };

  type.utfTextInput = function(letter, altText) {
    sendKey(letter, {text: altText});
  };

  type.clipboard = {};

  return type;
}();
