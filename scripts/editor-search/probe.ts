import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {openSearchPanel, getSearchQuery, SearchQuery, setSearchQuery} from '@codemirror/search';
import {countedSearch} from '../../src/modules/editor/lib/searchPanel';
import {SearchCountHub,searchCountHub} from '../../src/modules/editor/lib/searchCount';
import {queryEffects} from '../../src/modules/editor/search/regexState';
import {safeReplaceAll} from '../../src/modules/editor/search/regexView';
import {startRegex} from '../../src/modules/editor/search/regexClient';
const spec={search:'(a+)+$', replace:'Y', regexp:true as const, caseSensitive:false,wholeWord:false,literal:false};
async function waitFor(ready:()=>boolean, details:()=>unknown = () => null) {for(let i=0;i<200;i++){if(ready())return;await new Promise(r=>setTimeout(r,20));}throw new Error('UI did not settle: '+JSON.stringify(details()));}
async function probe() {
  let ticks=0;const timer=setInterval(()=>ticks++,10);
  try {await startRegex({text:Array(32).fill('a'.repeat(34)+'!').join('\n'),spec},undefined,200).result;throw new Error('Hostile regex did not time out');}
  catch(e){if(!String(e).includes('timed out'))throw e;}finally{clearInterval(timer);}
  if(!ticks)throw new Error('Main thread blocked');
  const hub=new SearchCountHub();const stop=hub.subscribe(()=>{});
  const view=new EditorView({parent:document.body,state:EditorState.create({doc:'x x',extensions:[countedSearch({top:true}),searchCountHub.of(hub)]})});
  try {
    await waitFor(()=>view.inView,()=>({phase:"visible",rect:view.dom.getBoundingClientRect().toJSON()}));openSearchPanel(view);
    view.dispatch({effects:queryEffects({...spec,search:'x'})});
    await waitFor(()=>hub.get()?.total===2 && !hub.get()?.pending,()=>({phase:"matches",count:hub.get(),inView:view.inView}));
    if(document.querySelectorAll('.cm-searchMatch').length!==2)throw new Error('Missing regex highlights');
    safeReplaceAll(view);
    if(view.state.doc.toString()!=='Y Y')throw new Error('Replace All failed');
    view.dispatch({effects:setSearchQuery.of(new SearchQuery({search:'Y',regexp:true}))});
    if(getSearchQuery(view.state).regexp)throw new Error('Synchronous regex escaped interception');
    await waitFor(()=>hub.get()?.total===2 && !hub.get()?.pending,()=>({phase:"matches",count:hub.get(),inView:view.inView}));
  }finally{view.destroy();stop();}
  return {passed:true,ticks,scheme:location.protocol,editorReplacement:true};
}
void probe().then(report,e=>report({passed:false,error:String(e)}));
function report(value:object){(window as unknown as {webkit?:{messageHandlers:{out:{postMessage:(s:string)=>void}}}}).webkit?.messageHandlers.out.postMessage(JSON.stringify(value));document.body.textContent=JSON.stringify(value);}
