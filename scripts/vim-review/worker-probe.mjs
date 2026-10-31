import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {RegexChannel} from '../../packages/codemirror-vim/async-runtime.js';
const cm={cm6:{state:EditorState.create({doc:'a'.repeat(34)+'!'})}};
let ticks=0;const timer=setInterval(()=>ticks++,10);
const channel=new RegexChannel(cm,200);
try {await assert.rejects(channel.request({kind:'cursor',source:'(a+)+$',flags:'',from:0}),/timed out/);}finally{clearInterval(timer);channel.close();}
assert.ok(ticks>0);
const recovery=new RegexChannel(cm);
try {const value=await recovery.request({kind:'cursor',source:'!',flags:'',from:0});assert.equal(value.from,34);}finally{recovery.close();}
console.log(JSON.stringify({passed:true,ticks,recovery:true}));
