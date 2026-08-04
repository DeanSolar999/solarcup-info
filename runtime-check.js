/* 瀏覽器 runtime 預檢（node runtime-check.js）
   補 predeploy-check.js 抓不到的那一類：未宣告變數、null dereference、
   modal 互動錯誤。這輪的 P0-01（strict mode 未宣告賦值害整個 LIVE 層失效）
   與 P1-05（曜請 modal 讀已移除的 progEl）都是靜態檢查全過、runtime 才炸。

   做法：不引入 JSDOM 依賴，改用 Node VM 直接跑各檔的 inline script，
   以最小 DOM stub 承接，只要拋例外就算失敗。 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const DIR=__dirname;
const bad=[];

// ---- 最小 DOM stub ----
function mkDoc(){
  const mk=()=>{const e={style:{setProperty(){},},classList:{add(){},remove(){},toggle(){},contains:()=>false},
    dataset:{},children:[],innerHTML:'',textContent:'',value:'0',
    appendChild(){},removeChild(){},insertAdjacentHTML(){},addEventListener(){},
    removeEventListener(){},querySelector:()=>mk(),querySelectorAll:()=>[],
    getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}),
    setAttribute(){},getAttribute:()=>null,closest:()=>mk(),focus(){},offsetWidth:1};
    return e;};
  return {createElement:mk,createElementNS:mk,createTextNode:mk,
    getElementById:()=>mk(),querySelector:()=>mk(),
    querySelectorAll:()=>[],getElementsByClassName:()=>[],addEventListener(){},
    body:mk(),documentElement:mk(),head:mk(),readyState:'complete'};
}
function sandbox(){
  // 瀏覽器語意：window 就是全域物件，bare `innerWidth` / `SolarCupLive` 才找得到
  const sb={
    innerWidth:1280,innerHeight:800,devicePixelRatio:1,
    addEventListener(){},removeEventListener(){},
    location:{hash:'',href:''},matchMedia:()=>({matches:false,addEventListener(){}}),
    document:mkDoc(),console:{log(){},warn(){},error(){}},
    setTimeout:()=>0,setInterval:()=>0,clearInterval(){},clearTimeout(){},
    requestAnimationFrame:()=>0,cancelAnimationFrame(){},
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,Boolean,RegExp,Error,isNaN,parseInt,parseFloat,
    fetch:()=>new Promise(()=>{}),navigator:{userAgent:'node'},performance:{now:()=>0},
    getComputedStyle:()=>({getPropertyValue:()=>''}),
    URLSearchParams:URLSearchParams,URL:URL,TextEncoder:TextEncoder,
    history:{replaceState(){},pushState(){}},localStorage:{getItem:()=>null,setItem(){}},
    THREE:undefined,SolarCupData:undefined,SolarCupLive:undefined,
  };
  sb.window=sb; sb.globalThis=sb; sb.self=sb;
  return sb;
}
function inlineScripts(file){
  const html=fs.readFileSync(path.join(DIR,file),'utf8');
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
}
// ---- 逐頁首屏：載入 data layer + 該頁 inline script，任何拋例外即失敗 ----
const PAGES=['solar-cup-two.html','qualifying.html','bracket-tree.html','invitational.html',
             'team-search.html','at-field-ranking.html','solar-cup-live.html','club-emblems.html'];
const dataLayer=fs.readFileSync(path.join(DIR,'tournament-data.js'),'utf8');
const liveLayer=fs.readFileSync(path.join(DIR,'live-data.js'),'utf8');
PAGES.forEach(f=>{
  const sb=sandbox(); vm.createContext(sb);
  try{ vm.runInContext(dataLayer,sb); vm.runInContext(liveLayer,sb); }
  catch(e){ bad.push(`${f} 資料層載入失敗：${e.message}`); return; }
  inlineScripts(f).forEach((code,i)=>{
    try{ vm.runInContext(code,sb,{timeout:8000}); }
    catch(e){
      if(/THREE|WebGL|canvas|getContext/i.test(e.message))return;   // 3D 背景在 node 無法執行，略過
      const at=(e.stack||'').split('\n').slice(1,3).map(x=>x.trim()).join(' ← ');
      bad.push(`${f} script[${i}] 首屏拋例外：${e.message.slice(0,110)}\n        ${at.slice(0,150)}`);
    }
  });
});

// ---- LIVE 成功／失敗 兩情境 ----
function liveScenario(fail){
  const sb=sandbox(); vm.createContext(sb);
  sb.fetch=(u)=>{
    if(fail)return Promise.reject(new Error('模擬斷線'));
    const name=decodeURIComponent(String(u).split('sheet=')[1]||'');
    const body=name==='8_發布_戰情看板'?'場次編號,隊A,隊B,分A,分B\n1,A,B,21,15\n':'欄1\nx\n';
    return Promise.resolve({ok:true,text:()=>Promise.resolve(body)});
  };
  vm.runInContext(liveLayer,sb);
  return sb.window.SolarCupLive.load();
}

(async()=>{
  const okD=await liveScenario(false);
  if(okD.state!=='fresh'||!okD.updatedAt)bad.push(`LIVE 全成功應為 fresh，實得 ${okD.state}`);
  const failD=await liveScenario(true);
  if(failD.state!=='cold'||failD.updatedAt!==null)bad.push(`LIVE 首次失敗應為 cold 且無時間，實得 ${failD.state}/${failD.updatedAt}`);

  // ---- playM／playMatch 的 done 契約 ----
  // 2026-08-03 全場演練抓到：bracket-tree 的 playM 只設 pending 沒設 done，
  // 但 rrRank 與循環賽場數統計讀的都是 m.done，於是每一場都被當成「未開打」丟掉——
  // 五角／三角循環的名次永遠是 0 勝、失分率 999，退回原始席次順序。
  // 競技組的準決賽名單直接吃這份名次，季軍推不出來、殿軍標錯，而且畫面不會報錯。
  {
    const bt=fs.readFileSync(path.join(DIR,'bracket-tree.html'),'utf8');
    const rets=[...bt.matchAll(/return\s*\{[^{}]*\bpending\s*:[^{}]*\}/g)].map(m=>m[0]);
    if(!rets.length)bad.push('bracket-tree 找不到 playM 的回傳物件（掃描規則可能過期）');
    rets.forEach(r=>{ if(!/\bdone\s*:/.test(r))
      bad.push(`bracket-tree playM 回傳只有 pending 沒有 done：${r.slice(0,70)}…（rrRank 會把該場當未開打丟掉）`); });
    // 有人讀 m.done 就一定要有人寫 done
    if(/\bm\.done\b/.test(bt)&&!/\bdone\s*:\s*true\b/.test(bt))
      bad.push('bracket-tree 有讀 m.done 卻沒有任何地方寫 done:true');
  }

  // ---- clubObj 必須帶 key ----
  // 2026-08-04：REG_OF 把球團物件重建成 {name,c}，丟掉了 key。徽記的中央圖案
  // （embFull／embCenter／embChip）是靠 key 查的，少了它只畫得出外圈文字、
  // 中間空一塊，而且完全不報錯。走這條路的是「雲端已填隊名」的隊伍，
  // 也就是淘汰賽開打後畫面上的每一隊。
  {
    const bt=fs.readFileSync(path.join(DIR,'bracket-tree.html'),'utf8');
    for(const m of bt.matchAll(/clubObj\s*:\s*\{[^{}]*\}/g)){
      const lit=m[0];
      const isTBD=/name\s*:\s*['"]{2}/.test(lit);          // 待定佔位沒有球團，例外
      if(!isTBD&&!/\bkey\s*:/.test(lit))
        bad.push(`bracket-tree 重建的 clubObj 少了 key：${lit.slice(0,64)}…（徽記中央會空白）`);
    }
  }

  // ---- 資料層三情境 + winner 空值巡檢 ----
  const sb=sandbox(); vm.createContext(sb); vm.runInContext(dataLayer,sb);
  const D=sb.window.SolarCupData;
  const all=[];Object.keys(D.QUAL_SCHEDULE).forEach(g=>D.QUAL_SCHEDULE[g].forEach(s=>all.push(s)));
  [0,0.4,1].forEach(frac=>{
    const m={};all.forEach((s,k)=>{if(k<Math.round(all.length*frac))m[String(s.n)]={a:s.a,b:s.b,sa:21,sb:11+(k%9),done:true};});
    try{
      const r=D.buildAllTeams({matches:m,hasReal:frac>0,qualRank:{}});
      r.teams.forEach(t=>t.matches.forEach(x=>{
        if(x.done&&!x.winner)throw new Error('done 卻無 winner');
        if(!x.done&&x.winner)throw new Error('pending 卻有 winner');
        if(x.done)void x.winner.club.c;
      }));
    }catch(e){bad.push(`資料層 ${frac*100}% 情境：${e.message}`);}
  });
  // 全站 winner.* 守衛巡檢
  const GUARD=/m\.winner&&|&&m\.winner|m\.winner\?|if\(m\.winner\)|\(m\.winner\b|m\.done\?|played\?|done\?|!m\.winner|!m\.done/;
  ['qualifying.html','bracket-tree.html','team-search.html','invitational.html','at-field-ranking.html'].forEach(f=>{
    const lines=fs.readFileSync(path.join(DIR,f),'utf8').split('\n');
    lines.forEach((L,i)=>{
      if(!/\w+\.winner\.\w+/.test(L))return;
      // 守衛可能寫在同一行，也可能是前幾行的 early return（if(!m.done||!m.winner){...return}）
      const ctx=lines.slice(Math.max(0,i-8),i+1).join('\n');
      if(!GUARD.test(ctx))bad.push(`${f}:${i+1} winner.* 未加守衛`);
    });
  });

  // ---- 重構殘留掃描：抓「宣告被刪、引用還在」這一類 ----
  // 首屏跑不到的路徑（modal、點擊 handler）用執行驗不到，改用宣告/引用比對。
  // P1-05（曜請 modal 讀已移除的 progEl）就屬於這一類。
  const DOMISH=/\b([a-zA-Z_$][\w$]*(?:El|Elem|Node|Btn|Mask|Card|Box))\b/g;
  ['qualifying.html','bracket-tree.html','invitational.html','team-search.html',
   'at-field-ranking.html','solar-cup-live.html','solar-cup-two.html'].forEach(f=>{
    inlineScripts(f).forEach((code,bi)=>{
      // 先剝除字串／樣板／註解——SVG 屬性名、base64、HTML 片段不是變數
      const src=code
        .replace(/`(?:\\.|[^`\\])*`/g,'``')
        .replace(/'(?:\\.|[^'\\])*'/g,"''")
        .replace(/"(?:\\.|[^"\\])*"/g,'""')
        .replace(/\/\*[\s\S]*?\*\//g,'')
        .replace(/(^|[^:])\/\/[^\n]*/g,'$1');
      const declared=new Set();
      // 逗號串接宣告：const a=…,b=…,c=…
      for(const m of code.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g))
        m[1].split(',').forEach(seg=>{const k=(seg.split('=')[0]||'').trim();
          if(/^[a-zA-Z_$][\w$]*$/.test(k))declared.add(k);});
      for(const m of code.matchAll(/\b(?:const|let|var|function)\s+([a-zA-Z_$][\w$]*)/g))declared.add(m[1]);
      for(const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g))
        m[1].split(',').forEach(x=>{const k=x.split(':').pop().trim();if(k)declared.add(k);});
      for(const m of code.matchAll(/\(([^)]*)\)\s*=>/g))
        m[1].split(',').forEach(x=>{const k=x.trim();if(/^[a-zA-Z_$][\w$]*$/.test(k))declared.add(k);});
      const seen=new Set();
      for(const m of src.matchAll(DOMISH)){
        const id=m[1];
        if(declared.has(id)||seen.has(id))continue;
        if(/^(document|window|HTMLElement|SVGElement)$/.test(id))continue;
        if(new RegExp('\\.'+id+'\\b').test(src))continue;   // 屬性存取，非自由變數
        seen.add(id);
        bad.push(`${f} script[${bi}] 引用未宣告的 ${id}（重構殘留？）`);
      }
    });
  });

  // ---- 無比分 UI 基準：不允許舊示範／假晉級狀態重新混入 ----
  const liveTxt=fs.readFileSync(path.join(DIR,'solar-cup-live.html'),'utf8');
  if(/示範模式/.test(liveTxt))bad.push('solar-cup-live.html 殘留「示範模式」文案');
  if(!/timeZone:'Asia\/Taipei'/.test(liveTxt)||!/\(t<0\|\|!anyScore\)\?-1:t/.test(liveTxt))
    bad.push('solar-cup-live.html 無比分／非賽事日的台北時區 gate 不完整');
  if(/updateLive\('live'\);\s*[\s\S]{0,220}LIVE=true;\s*setInterval\(render,30000\)/.test(liveTxt))
    bad.push('solar-cup-live.html 首屏仍會未比分即啟用 LIVE 真實時鐘');

  const bracketTxt=fs.readFileSync(path.join(DIR,'bracket-tree.html'),'utf8');
  if(!/const doneCount=gm\.filter\(m=>m&&m\.done&&m\.winner\)\.length;/.test(bracketTxt)
    || !/尚無賽果 · 循環榜待啟動/.test(bracketTxt))
    bad.push('bracket-tree.html 組進程 modal 缺少 0 場賽果 placeholder guard');
  if(!/const advSet=groupDone\?new Set\(\[rank\[0\]\.i,rank\[1\]\.i\]\):new Set\(\);/.test(bracketTxt)
    || !/groupDone\?\(adv\?'晉級':'止步'\):'暫列'/.test(bracketTxt))
    bad.push('bracket-tree.html 未完成循環仍可能展示正式晉級／止步');

  const invitTxt=fs.readFileSync(path.join(DIR,'invitational.html'),'utf8');
  if(!/<span class="st" id="progSt">連線中…<\/span>/.test(invitTxt))
    bad.push('invitational.html 初始進度不是「連線中…」');

  // ---- 戰情頁時區 API 失效時必須 fail-closed，不能退回裝置本地時鐘 ----
  try{
    const sb=sandbox();
    sb.Intl={DateTimeFormat(){throw new Error('模擬 Intl 不可用');}};
    vm.createContext(sb);
    vm.runInContext(dataLayer,sb); // 名單資料
    vm.runInContext(fs.readFileSync(path.join(DIR,'schedule-data.js'),'utf8'),sb);
    const solarCode=inlineScripts('solar-cup-live.html').find(x=>x.includes('function isEventDay'));
    if(!solarCode)throw new Error('找不到戰情頁狀態 script');
    const exposed=solarCode.replace(/\}\)\(\);\s*$/,
      'globalThis.__solarGate={isEventDay,realClockMin,nowMin,nowStr};})();');
    vm.runInContext(exposed,sb,{timeout:8000});
    const gate=sb.__solarGate;
    if(!gate||gate.isEventDay()!==false||gate.realClockMin()!==-1||gate.nowMin()!==-1||gate.nowStr()!=='—')
      throw new Error('Intl 失效時未完整 fail-closed');
  }catch(e){bad.push(`solar-cup-live.html Taipei gate fail-closed：${e.message}`);}

  if(bad.length){console.error('❌ runtime 預檢失敗：');bad.forEach(b=>console.error('   · '+b));process.exit(1);}
  console.log(`✅ ${PAGES.length} 頁首屏 0 例外`);
  console.log('✅ LIVE fresh／cold 兩情境正確');
  console.log('✅ 資料層 0%／40%／100% 三情境 0 例外');
  console.log('✅ 全站 winner.* 守衛無遺漏');
})();
