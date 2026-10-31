import assert from 'node:assert/strict';
import {startRegex} from '../../src/modules/editor/search/regexClient.ts';
const spec={search:'(a+)+$', replace:'Y', regexp:true, caseSensitive:false,wholeWord:false,literal:false};
let ticks=0;const timer=setInterval(()=>ticks++,10);
try {await assert.rejects(startRegex({text:Array(32).fill('a'.repeat(34)+'!').join('\n'),spec},undefined,200).result,/timed out/);}finally{clearInterval(timer);}
assert.ok(ticks>0);
const matches=await startRegex({text:'x x',spec:{...spec,search:'(x)',replace:'$1!'}}).result;
assert.deepEqual(matches,[{from:0,to:1,insert:'x!'},{from:2,to:3,insert:'x!'}]);
console.log(JSON.stringify({passed:true,ticks,recovery:true}));
