/* 部署前資料層完整性檢查（node predeploy-check.js）
   防的是「編輯期」的靜默損壞——例如隊名一個字壞掉，runGroup 會默默少生成一場，
   150→149 且 rnd() 消耗位移，下游全部連動偏移卻不報錯。2026-07-31 實際踩過一次。 */
const fs=require('fs'), path=require('path');
const DIR=__dirname;
const src=fs.readFileSync(path.join(DIR,'tournament-data.js'),'utf8');
eval(src.replace(/\}\)\(typeof window[^\n]*$/m,'})(globalThis);'));
const D=globalThis.SolarCupData;

const T=D.buildTournament(20260815), A=D.buildAllTeams(20260815);
const quals=[...T.qualGroups.comp,...T.qualGroups.casual].reduce((s,g)=>s+g.matches.length,0);
const bad=[];
if(quals!==150) bad.push(`資格賽場次 ${quals}/150（QUAL_SCHEDULE 與 ROSTER 隊名可能不符）`);
if(A.teams.length!==108) bad.push(`隊數 ${A.teams.length}/108`);
[['plat',20],['gold',20],['silver',30],['bronze',30]].forEach(([k,n])=>{
  if(T.tiers[k].length!==n) bad.push(`${k} ${T.tiers[k].length}/${n}`);
});
const groups={};A.teams.forEach(t=>{const g=t.track==='曜請'?'曜請':t.group;groups[g]=(groups[g]||0)+1;});
const gbad=Object.keys(groups).filter(g=>g!=='曜請'&&groups[g]!==4);
if(gbad.length) bad.push(`組別人數非 4：${gbad.join(',')}`);
if(groups['曜請']!==8) bad.push(`曜請 ${groups['曜請']}/8`);
// 靜默損壞的典型痕跡：替換字元
['tournament-data.js','qualifying.html'].forEach(f=>{
  const n=(fs.readFileSync(path.join(DIR,f),'utf8').match(/�/g)||[]).length;
  if(n) bad.push(`${f} 有 ${n} 個損壞字元 U+FFFD`);
});

if(bad.length){console.error('❌ 資料層完整性失敗：');bad.forEach(b=>console.error('   · '+b));process.exit(1);}
console.log('✅ 資料層完整性：資格賽 150 場 / 108 隊 / 20-20-30-30 / 25 組各 4 隊 / 曜請 8 / 無損壞字元');
