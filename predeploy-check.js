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

if(bad.length){console.error('❌ 資料層完整性失敗：');bad.forEach(b=>console.error('   · '+b));process.exit(1);}
console.log('✅ 賽前：150 場全未開打 / 108 隊 / 分級全空 / 25 組各 4 隊 / 曜請 28 場');
console.log('✅ 灌滿：分級 20-20-30-30 / 25 組全完賽');
console.log('✅ 站上無模擬引擎殘留、無損壞字元');
