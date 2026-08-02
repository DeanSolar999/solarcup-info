/* 部署前資料層完整性檢查（node predeploy-check.js）
   防的是「編輯期」的靜默損壞——例如隊名一個字壞掉，runGroup 會默默少生成一場，
   150→149 且下游全部連動偏移卻不報錯。2026-07-31 實際踩過一次。

   2026-08-01 起站上已無模擬資料，因此本檔改為雙情境驗證：
   ① 賽前（無雲端資料）：150 場全部未開打、分級全空、零假分數
   ② 灌滿（模擬雲端已完賽）：分級 20/20/30/30、每組 6 場完賽
   ② 的「模擬」只存在於這支檢查腳本，網站程式本身不含任何隨機或假比分。 */
const fs=require('fs'), path=require('path');
const DIR=__dirname;
const src=fs.readFileSync(path.join(DIR,'tournament-data.js'),'utf8');
eval(src.replace(/\}\)\(typeof window[^\n]*$/m,'})(globalThis);'));
const D=globalThis.SolarCupData;
const bad=[];

// ── ① 賽前：無雲端資料 ──────────────────────────────────────────
const T0=D.buildTournament(null), A0=D.buildAllTeams(null);
const quals=[...T0.qualGroups.comp,...T0.qualGroups.casual].reduce((s,g)=>s+g.matches.length,0);
if(quals!==150) bad.push(`資格賽場次 ${quals}/150（QUAL_SCHEDULE 與 ROSTER 隊名可能不符）`);
if(A0.teams.length!==108) bad.push(`隊數 ${A0.teams.length}/108`);
const played0=A0.teams.reduce((s,t)=>s+t.matches.filter(m=>m.done).length,0);
if(played0!==0) bad.push(`賽前竟有 ${played0} 場已完賽（疑似殘留假分數）`);
const tier0=['plat','gold','silver','bronze'].reduce((s,k)=>s+T0.tiers[k].length,0);
if(tier0!==0) bad.push(`賽前分級竟已定案 ${tier0} 隊（應為 0，資格賽未完賽不得分流）`);
if(A0.invitational.matches.length!==28) bad.push(`曜請場次 ${A0.invitational.matches.length}/28`);

const groups={};A0.teams.forEach(t=>{const g=t.track==='曜請'?'曜請':t.group;groups[g]=(groups[g]||0)+1;});
const gbad=Object.keys(groups).filter(g=>g!=='曜請'&&groups[g]!==4);
if(gbad.length) bad.push(`組別人數非 4：${gbad.join(',')}`);
if(groups['曜請']!==8) bad.push(`曜請 ${groups['曜請']}/8`);

// ── ② 灌滿：模擬雲端 150 場全完賽 ────────────────────────────────
const matches={};
Object.keys(D.QUAL_SCHEDULE).forEach(gid=>{
  D.QUAL_SCHEDULE[gid].forEach((s,i)=>{
    matches[String(s.n)]={a:s.a,b:s.b,sa:21,sb:11+(i%9),done:true};
  });
});
if(Object.keys(matches).length!==150) bad.push(`QUAL_SCHEDULE 場次數 ${Object.keys(matches).length}/150`);
const T1=D.buildTournament({matches,hasReal:true,qualRank:{}});
[['plat',20],['gold',20],['silver',30],['bronze',30]].forEach(([k,n])=>{
  if(T1.tiers[k].length!==n) bad.push(`灌滿後 ${k} ${T1.tiers[k].length}/${n}`);
});
const notDone=[...T1.qualGroups.comp,...T1.qualGroups.casual].filter(g=>!g.done);
if(notDone.length) bad.push(`灌滿後仍有 ${notDone.length} 組未完賽：${notDone.map(g=>g.gid).join(',')}`);

// ── ③ 站上不得殘留模擬引擎 ──────────────────────────────────────
const BANNED=[/rnd\(\)\s*<\s*0\.5/, /function\s+score\s*\(win\)/, /DEMO 球員暱稱池/, /NICK_POOL/];
['tournament-data.js','qualifying.html','bracket-tree.html','invitational.html'].forEach(f=>{
  const txt=fs.readFileSync(path.join(DIR,f),'utf8');
  const n=(txt.match(/�/g)||[]).length;
  if(n) bad.push(`${f} 有 ${n} 個損壞字元 U+FFFD`);
  BANNED.forEach(re=>{ if(re.test(txt)) bad.push(`${f} 殘留模擬引擎：${re}`); });
});

// ── ④ 展示控制項掃描（2026-08-02 新增）────────────────────────────
// 起因：真串接改版時只換了資料來源，卻忘了拆展示用的互動控制項——
// bracket-tree 的進度拉桿與寫死的 progState 撐到上線後才被團長抓到，
// 造成賽前顯示假進度、假晉級名單與 sentinel 999.000。
// runtime-check 抓不到這一類（畫面不會崩，只是顯示錯的東西）。
const PAGES_UI=['solar-cup-two.html','qualifying.html','bracket-tree.html','invitational.html',
                'team-search.html','at-field-ranking.html','solar-cup-live.html'];
// 白名單：純視覺偏好控制項，與賽事資料無關
const UI_OK=new Set(['recOpa','rwmR']);
PAGES_UI.forEach(f=>{
  const txt=fs.readFileSync(path.join(DIR,f),'utf8');
  // (a) 任何 range 拉桿：非白名單即視為殘留的展示控制項
  for(const m of txt.matchAll(/<input[^>]*type="range"[^>]*>/g)){
    const id=(m[0].match(/id="([^"]+)"/)||[])[1]||'(無 id)';
    if(!UI_OK.has(id))bad.push(`${f} 殘留展示拉桿 <input type="range" id="${id}">`);
  }
  // (b) 寫死的展示狀態：progState / simProg 之類被賦上非零初始值
  for(const m of txt.matchAll(/\b(progState|simState|demoState)\s*=\s*\{([^}]*)\}/g)){
    const vals=[...m[2].matchAll(/:\s*(\d+)/g)].map(x=>+x[1]);
    if(vals.some(v=>v!==0))bad.push(`${f} ${m[1]} 有寫死的非零初始值 {${m[2].trim()}}`);
  }
  // (c) 明顯的示範用識別字
  ['demoTime','demoNowMin','recomputeDemo','seedScore','demoUpdate','simProg'].forEach(k=>{
    if(new RegExp('\\b'+k+'\\b').test(txt))bad.push(`${f} 殘留示範程式碼識別字 ${k}`);
  });
  // (d) 失效的拉桿樣式（display:none 藏起來但沒刪）
  if(/\.(pgrange|simbar input|progbar input)\{display:none/.test(txt))
    bad.push(`${f} 有被 display:none 藏起來的拉桿樣式（應刪除而非隱藏）`);
});

if(bad.length){console.error('❌ 資料層完整性失敗：');bad.forEach(b=>console.error('   · '+b));process.exit(1);}
console.log('✅ 賽前：150 場全未開打 / 108 隊 / 分級全空 / 25 組各 4 隊 / 曜請 28 場');
console.log('✅ 灌滿：分級 20-20-30-30 / 25 組全完賽');
console.log('✅ 站上無模擬引擎殘留、無損壞字元');
console.log('✅ 無殘留展示拉桿／寫死展示狀態');
