import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fontDir = process.argv[2];
const sharpModule = process.argv[3];
if (!fontDir || !sharpModule) throw new Error('Usage: bun branding/source/build.mjs <official-satoshi-ttf-folder> <sharp-module-path>');
const sharp = (await import(sharpModule)).default;
const C = { navy: '#15222F', silver: '#E9EEF3', steel: '#C9D6E2', night: '#0B141D', white: '#FFFFFF', black: '#000000' };
const out = async (name, content) => { const p = resolve(root, name); await mkdir(dirname(p), { recursive: true }); await writeFile(p, content); };
const svg = (w, h, content, title = 'Oarlock') => '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + title + '"><title>' + title + '</title>' + content + '</svg>';
const rect = (x,y,w,h,fill,rx=0) => '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+fill+'"/>';
const line = (x1,y1,x2,y2,color,width=1) => '<path d="M'+x1+' '+y1+'L'+x2+' '+y2+'" stroke="'+color+'" stroke-width="'+width+'"/>';

function roundedPolygon(points, radius) {
  const entries = points.map((p,i) => {
    const prev=points[(i+points.length-1)%points.length], next=points[(i+1)%points.length];
    const a=Math.hypot(prev[0]-p[0],prev[1]-p[1]), b=Math.hypot(next[0]-p[0],next[1]-p[1]);
    const r=Math.min(radius,a/3,b/3);
    return {p, before:[p[0]+(prev[0]-p[0])*r/a,p[1]+(prev[1]-p[1])*r/a], after:[p[0]+(next[0]-p[0])*r/b,p[1]+(next[1]-p[1])*r/b]};
  });
  const n=v=>Number(v.toFixed(3));
  return 'M'+entries[0].before.map(n).join(' ') + entries.map((e,i)=>(i?'L'+e.before.map(n).join(' '):'')+'Q'+e.p.map(n).join(' ')+' '+e.after.map(n).join(' ')).join('')+'Z';
}
const outer = roundedPolygon([[144,95],[355,95],[469,208],[469,416],[355,526],[144,526],[27,412],[27,208]],18);
const inner = roundedPolygon([[169,163],[329,163],[401,235],[401,385],[329,457],[169,457],[95,383],[95,237]],10);
const head = roundedPolygon([[400,70],[460,10],[553,10],[553,99],[493,162],[400,162]],7);
const headHole = 'M431 71L464 41H521V94L489 128V71Z';
let uid=0;
function mark(color=C.silver, x=0, y=0, size=576) {
  const id='ring-gap-'+uid++;
  return '<g transform="translate('+x+' '+y+') scale('+size/576+')" fill="'+color+'"><defs><mask id="'+id+'" maskUnits="userSpaceOnUse" x="0" y="0" width="576" height="576"><rect width="576" height="576" fill="white"/><path d="M-20 585L585 -20" fill="none" stroke="black" stroke-width="87"/></mask></defs><path d="'+outer+inner+'" fill-rule="evenodd" mask="url(#'+id+')"/><rect x="0" y="-27" width="583" height="54" rx="5" transform="translate(29 526) rotate(-45)"/><path d="'+head+headHole+'" fill-rule="evenodd"/></g>';
}

const fonts={};
for (const weight of ['Black','Bold','Medium','Regular']) {
  const data=await readFile(resolve(fontDir,'Satoshi-'+weight+'.ttf'));
  fonts[weight]=new hb.Font(new hb.Face(new hb.Blob(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength))));
}
function textShape(text, weight='Regular') {
  const f=fonts[weight], b=new hb.Buffer(); b.addText(text); b.guessSegmentProperties(); hb.shape(f,b);
  const infos=b.getGlyphInfos(), positions=b.getGlyphPositions(); let x=0, minX=Infinity, minY=Infinity, maxX=-Infinity,maxY=-Infinity;
  const paths=infos.map((info,i)=>{
    const pos=positions[i], e=f.glyphExtents(info.codepoint), gx=x+pos.xOffset, gy=pos.yOffset;
    if(e && e.width) {minX=Math.min(minX,gx+e.xBearing); maxX=Math.max(maxX,gx+e.xBearing+e.width); minY=Math.min(minY,gy+e.yBearing+e.height);maxY=Math.max(maxY,gy+e.yBearing);}
    const p='<path d="'+f.glyphToPath(info.codepoint)+'" transform="translate('+gx+' '+gy+')"/>'; x+=pos.xAdvance;return p;
  }).join('');
  return {paths,minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY,advance:x};
}
function text(text,x,y,size=24,color=C.silver,weight='Regular') {
  const t=textShape(text,weight), scale=size/1000;
  return '<g fill="'+color+'" transform="translate('+x+' '+(y+t.maxY*scale)+') scale('+scale+' '+(-scale)+')">'+t.paths+'</g>';
}
const wm=textShape('oarlock','Black');
function wordmark(color,x,y,height) {
  const s=height/wm.height;
  return '<g fill="'+color+'" transform="translate('+(x-wm.minX*s)+' '+(y+wm.maxY*s)+') scale('+s+' '+(-s)+')">'+wm.paths+'</g>';
}
function lockup(color,x,y,width) {
  const baseWidth=1110, s=width/baseWidth;
  return '<g transform="translate('+x+' '+y+') scale('+s+')">'+mark(color,0,0,300)+wordmark(color,330,78,160)+'</g>';
}
async function asset(name,w,h,content,pngWidth=w) {
  const contentSvg=svg(w,h,content);
  await out(name+'.svg',contentSvg);
  await out(name+'.png',await sharp(Buffer.from(contentSvg)).resize({width:pngWidth}).png().toBuffer());
}
for (const [name,color] of Object.entries({navy:C.navy,silver:C.silver,black:C.black,white:C.white})) {
  await asset('logo/mark-'+name,576,576,mark(color),2048);
  await asset('logo/wordmark-'+name,Math.ceil(wm.width/wm.height*160)+4,164,wordmark(color,2,2,160),2400);
  await asset('logo/horizontal-'+name,1206,396,lockup(color,48,48,1110),2400);
  const stackedHeight=144;
  await asset('logo/stacked-'+name,800,790,mark(color,150,34,500)+wordmark(color,(800-wm.width/wm.height*stackedHeight)/2,594,stackedHeight),1600);
}
await out('source/mark.svg',svg(576,576,mark(C.navy)));
await out('source/wordmark.svg',svg(Math.ceil(wm.width/wm.height*160)+4,164,wordmark(C.navy,2,2,160)));
await out('source/geometry.json',JSON.stringify({version:'1.0',reference:'Approved 4B balanced proportions v3',viewBox:[0,0,576,576],outerRingPath:outer,innerRingPath:inner,oarShaft:{start:[29,526],angle:-45,width:54,length:583,cornerRadius:5},bladePath:head,bladeCutout:headHole,ringGapWidth:87,wordmark:{font:'Satoshi',weight:900,source:'https://www.fontshare.com/fonts/satoshi',outlined:true}},null,2)+'\n');

const desktopIcon=svg(1024,1024,rect(64,64,896,896,C.navy,196)+mark(C.silver,174,174,676));
const fullIcon=svg(1024,1024,rect(0,0,1024,1024,C.navy)+mark(C.silver,146,146,732));
await out('app/icon.svg',desktopIcon); await out('app/icon-full-bleed.svg',fullIcon);
await asset('app/icon-light',1024,1024,rect(64,64,896,896,C.silver,196)+mark(C.navy,174,174,676));
for(const size of [16,24,32,48,64,128,256,512,1024]) await out('app/icon-'+size+'.png',await sharp(Buffer.from(desktopIcon)).resize(size,size).png().toBuffer());
await out('app/icon-full-bleed-1024.png',await sharp(Buffer.from(fullIcon)).png().toBuffer());
await asset('app/android-background',1080,1080,rect(0,0,1080,1080,C.navy));
await asset('app/android-foreground',1080,1080,mark(C.silver,300,300,480));
await asset('app/android-monochrome',1080,1080,mark(C.white,300,300,480));
await out('app/icon-manifest.json',JSON.stringify({default:'icon-1024.png',bg_color:C.navy,android_bg:'android-background.png',android_fg:'android-foreground.png',android_fg_scale:100,android_monochrome:'android-monochrome.png'},null,2)+'\n');
const favicon=svg(64,64,rect(0,0,64,64,C.navy,13)+mark(C.silver,8,8,48));
await out('web/favicon.svg',favicon);
for(const size of [16,32,48]) await out('web/favicon-'+size+'.png',await sharp(Buffer.from(favicon)).resize(size,size).png().toBuffer());
for(const [size,name] of [[180,'apple-touch-icon'],[192,'icon-192'],[512,'icon-512']]) await out('web/'+name+'.png',await sharp(Buffer.from(fullIcon)).resize(size,size).png().toBuffer());
await out('web/site.webmanifest',JSON.stringify({name:'Oarlock',short_name:'Oarlock',description:'An AI-native terminal for developers.',start_url:'/',scope:'/',display:'standalone',background_color:C.navy,theme_color:C.navy,icons:[{src:'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]},null,2)+'\n');

function social(w,h,tagline) {
  return rect(0,0,w,h,C.navy)+text('OARLOCK',72,55,19,C.steel,'Bold')+lockup(C.silver,70,147,w-140)+line(74,h-154,w-74,h-154,C.steel,1)+text(tagline,74,h-113,30,C.silver,'Medium')+text('Open source. AI-native. Built for developers.',74,h-61,19,C.steel);
}
await asset('social/social-card',1200,630,social(1200,630,'Your agents. Your machines. Your direction.'));
await asset('social/repository-card',1280,640,social(1280,640,'An AI-native terminal. Your workflow, your control.'));

const sections=[];
function page(number,title,subtitle,body,dark=false) {
  const bg=dark?C.navy:C.white, fg=dark?C.silver:C.navy;
  const content=rect(0,0,1600,1000,bg)+text('OARLOCK / BRAND SYSTEM',70,48,20,dark?C.steel:C.navy,'Bold')+text(title,70,113,60,fg,'Black')+(subtitle?text(subtitle,72,197,25,dark?C.steel:C.navy):'')+body+line(70,924,1530,924,dark?'#344653':'#DCE3E9')+text('VERSION 1.0 / OCTOBER 2026',70,950,17,dark?C.steel:C.navy)+text(String(number).padStart(2,'0'),1490,945,24,dark?C.steel:C.navy,'Bold');
  sections.push({number,title,svg:svg(1600,1000,content,'Oarlock brand guide: '+title)});
}
page(1,'Take the helm.','Your agents. Your machines. Your direction.',lockup(C.silver,95,337,1380)+text('An independent identity for an AI-native terminal',74,780,28,C.silver,'Medium')+text('and the self-hosted agent workbench ahead.',74,823,28,C.steel),true);
page(2,'One mark. Three connections.','A precise symbol for direction, boundaries and direct interaction.',mark(C.navy,85,296,480)+text('OAR / DIRECTION',670,297,23,C.navy,'Bold')+text('The diagonal oar carries movement and intent.',670,338,27,C.navy)+text('O / BOUNDARY',670,427,23,C.navy,'Bold')+text('The open octagon suggests a workspace you control.',670,468,27,C.navy)+text('PROMPT / ACTION',670,557,23,C.navy,'Bold')+text('An angular cutout echoes a terminal chevron.',670,598,27,C.navy)+text('Always use the supplied master artwork.',670,744,24,C.navy,'Bold')+text('Keep its flat oar end and subtly eased corners.',670,785,24,C.navy));
page(3,'A logo for every surface.','Use one-color artwork and choose the highest-contrast version.',rect(70,270,710,240,C.navy,18)+lockup(C.silver,102,300,642)+rect(820,270,710,240,'#F1F4F7',18)+lockup(C.navy,852,300,642)+mark(C.navy,84,574,250)+wordmark(C.navy,399,645,80)+text('Standalone symbol',91,852,22,C.navy,'Medium')+text('Outlined wordmark',404,852,22,C.navy,'Medium')+rect(1200,570,260,260,C.navy,56)+mark(C.silver,1236,606,188)+text('App tile',1250,852,22,C.navy,'Medium'));
const clearBox='<rect x="90" y="274" width="566" height="566" fill="none" stroke="#A7B5C2" stroke-dasharray="8 8"/>';
page(4,'Give the mark room.','Preserve the proportions, negative space and diagonal angle.',clearBox+mark(C.navy,143,327,460)+text('CLEAR SPACE',770,284,23,C.navy,'Bold')+text('Leave at least one shaft width on every side.',770,328,25,C.navy)+text('Use the padded lockup files without cropping.',770,371,25,C.navy)+text('MINIMUM DIGITAL SIZE',770,460,23,C.navy,'Bold')+mark(C.navy,782,519,24)+text('24 px symbol',828,521,25,C.navy)+text('140 px horizontal lockup',782,576,25,C.navy)+text('16 px is reserved for favicons.',782,624,23,C.navy)+text('KEEP IT CONSISTENT',770,728,23,C.navy,'Bold')+text('Do not stretch, rotate, outline or add effects.',770,772,25,C.navy)+text('Keep the symbol and wordmark in one color.',770,815,25,C.navy));
let swatches='';
const colors=[['NAVY',C.navy,'Primary surfaces'],['SILVER',C.silver,'Marks on dark'],['STEEL',C.steel,'Supporting copy'],['NIGHT',C.night,'Deeper surfaces'],['WHITE',C.white,'Light surfaces']];
colors.forEach(([name,color,use],i)=>{
 const x=70+i*296; swatches+=rect(x,292,270,270,color,16)+(color===C.white?'<rect x="'+x+'" y="292" width="270" height="270" rx="16" fill="none" stroke="#DCE3E9"/>':'')+text(name,x,597,24,C.navy,'Bold')+text(color,x,646,26,C.navy,'Medium')+text(use,x,696,21,C.navy);
});
page(5,'Quiet color. Clear contrast.','Navy and silver are the primary brand pair.',swatches+text('Use navy artwork on white, or silver artwork on navy.',70,807,29,C.navy,'Medium')+text('Steel supports dark surfaces. It is not body text on white.',70,855,24,C.navy));
page(6,'Geometric. Human. Direct.','A bold wordmark with practical supporting typography.',text('Satoshi Black',75,288,82,C.navy,'Black')+text('Brand headlines and the supplied outlined wordmark.',78,405,28,C.navy)+text('abcdefghijklmnopqrstuvwxyz',78,465,49,C.navy,'Black')+text('0123456789 / Your workflow, your control.',78,536,38,C.navy,'Medium')+line(78,624,1520,624,'#DCE3E9')+text('INTER',78,668,22,C.navy,'Bold')+text('Product UI and longer reading.',78,710,27,C.navy)+text('Use the existing app family.',78,759,24,C.navy)+text('JETBRAINS MONO',810,668,22,C.navy,'Bold')+text('Terminal output and code.',810,710,27,C.navy)+text('Keep code legible and literal.',810,759,24,C.navy)+text('Wordmarks are outlined. Obtain Satoshi fonts directly from Fontshare.',78,853,22,C.navy));
page(7,'Speak with purpose.','Capable, independent and approachable.',text('PRIMARY LINE',76,286,22,C.navy,'Bold')+text('Your agents. Your machines. Your direction.',76,331,47,C.navy,'Black')+text('CURRENT PRODUCT',76,452,22,C.navy,'Bold')+text('An open-source, AI-native terminal for developers.',76,496,33,C.navy,'Medium')+text('LONG-TERM VISION',76,614,22,C.navy,'Bold')+text('A self-hosted workbench for coding agents',76,657,33,C.navy,'Medium')+text('in sandboxes on machines you own.',76,704,33,C.navy,'Medium')+text('Write concrete benefits. Name supported features accurately.',76,819,25,C.navy)+text('Describe mobile clients and remote sandboxes as vision until available.',76,864,23,C.navy));
const appBody=rect(70,281,420,420,'#203141',30)+rect(96,307,368,368,C.navy,80)+mark(C.silver,149,360,262)+text('Desktop app',76,744,25,C.navy,'Bold')+rect(578,281,946,100,C.navy,16)+mark(C.silver,603,301,56)+text('Oarlock',685,311,29,C.silver,'Bold')+rect(578,410,946,229,C.navy,16)+mark(C.silver,618,443,144)+text('Your agents.',804,444,48,C.silver,'Black')+text('Your machines.',804,506,48,C.silver,'Black')+text('Your direction.',804,568,48,C.silver,'Black')+text('Browser and social applications',583,684,25,C.navy,'Bold')+text('Assets are supplied for desktop, mobile and web handoff.',76,840,28,C.navy);
page(8,'Ready for the real world.','One consistent identity across app icons, web and launch assets.',appBody);
for(const p of sections) {
 await out('guide/pages/'+String(p.number).padStart(2,'0')+'.svg',p.svg);
 await out('guide/pages/'+String(p.number).padStart(2,'0')+'.png',await sharp(Buffer.from(p.svg)).resize(2400,1500).png().toBuffer());
}
const preview=svg(1800,1200,rect(0,0,1800,1200,C.navy)+text('OARLOCK / IDENTITY SYSTEM',74,54,23,C.steel,'Bold')+lockup(C.silver,78,136,1600)+line(75,600,1725,600,'#344653')+text('Your agents. Your machines. Your direction.',77,650,43,C.silver,'Medium')+rect(78,795,228,228,C.night,49)+mark(C.silver,110,827,164)+rect(368,795,228,228,C.silver,49)+mark(C.navy,400,827,164)+mark(C.silver,690,810,200)+rect(1120,810,176,176,C.silver,20)+rect(1324,810,176,176,C.steel,20)+rect(1528,810,176,176,C.night,20)+text('APP ICONS',83,1065,20,C.steel,'Bold')+text('STANDALONE MARK',671,1065,20,C.steel,'Bold')+text('NAVY / SILVER / STEEL / NIGHT',1119,1065,20,C.steel,'Bold'));
await out('brand-overview.svg',preview);
await out('brand-overview.png',await sharp(Buffer.from(preview)).png().toBuffer());
await out('tokens/colors.json',JSON.stringify({brand:{name:'Oarlock',version:'1.0'},colors:C,typography:{wordmark:'Satoshi Black (outlined master)',headings:'Satoshi',interface:'Inter',code:'JetBrains Mono'}},null,2)+'\n');
await out('tokens/brand.css',':root {\n  --oarlock-navy: #15222f;\n  --oarlock-silver: #e9eef3;\n  --oarlock-steel: #c9d6e2;\n  --oarlock-night: #0b141d;\n  --oarlock-white: #ffffff;\n  --oarlock-font-brand: "Satoshi", "Inter", sans-serif;\n  --oarlock-font-ui: "Inter", system-ui, sans-serif;\n  --oarlock-font-code: "JetBrains Mono", monospace;\n}\n');
await mkdir(resolve(root,'reference'),{recursive:true});
if (process.argv[4]) await copyFile(resolve(process.argv[4]),resolve(root,'reference/approved-4B.png'));
await copyFile(resolve(fontDir,'FFL.txt'),resolve(root,'source/Satoshi-license.txt'));
console.log('Created logo masters, PNG exports, app and web assets, social cards and eight guide pages.');
