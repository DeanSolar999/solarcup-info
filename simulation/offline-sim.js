'use strict';

/* 離線全場模擬（不碰雲端）
   ────────────────────────────────────────────────────────────
   產生 310 場的隊名＋比分，以及「這一套分數應該算出什麼結果」的預期值，
   輸出成 JSON 給 verify_offline.py 灌進本機 xlsx、用 formulas 重算後逐項比對。

   這裡刻意只本地模擬後端的「兩條規則」，其餘全部交給真公式去算：
     ① 資格賽四角循環 → 組內排名 → 前二／後二分流
     ② 淘汰賽勝方 ＝ 分數大者（後端 O 欄 IF(M>N,I,K)）
   比對的意義就在這：如果重算結果跟這裡的預期不同，代表公式鏈有問題。

   用法：node offline-sim.js <輸出.json> [run-id]
*/

const fs = require('node:fs');
const path = require('node:path');
const { scoreFor, assertLegalScore } = require('./lib');
const { loadTopology, knockoutNumbers, deriveAll, seedsFor, rankGroup, TIER_KEYS, TIER_META } = require('./bracket');

const SCRIPTS = path.join(process.env.HOME, 'Desktop', '曜日盃賽務資料', '後端資料庫_建置腳本');
const RUN_ID = process.argv[3] || 'offline-verify';
const OUT = process.argv[2] || '/tmp/sim-310.json';

const roster = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'dataset.json'), 'utf8')).roster;
const draw = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'draw_full.json'), 'utf8'));
const topology = loadTopology();
const KNOCK_NOS = knockoutNumbers(topology);

const typeOf = new Map(roster.map((t) => [t.name, t.type]));
const clubOf = new Map(roster.map((t) => [t.name, t.club]));

// ── ① 資格賽 150 場 ───────────────────────────────────────────
const qual = {};
draw.matches.forEach((m, i) => {
  const score = scoreFor(RUN_ID, `qual-${i + 1}`);
  assertLegalScore(score);
  qual[m.n] = { a: m.a, b: m.b, sa: score[0], sb: score[1], code: m.code };
});

// 四角循環 → 組內排名 → 前二／後二分流（＝後端 3_資格賽積分榜 的行為）
const groups = Array.isArray(draw.groups) ? Object.fromEntries(draw.groups) : draw.groups;
const qualRows = [];
Object.entries(groups).forEach(([code, teams]) => {
  const ms = Object.values(qual).filter((m) => m.code === code)
    .map((m) => ({ a: m.a, b: m.b, sa: m.sa, sb: m.sb, done: true }));
  if (ms.length !== 6) throw new Error(`GROUP_MATCHES:${code}=${ms.length}/6`);
  const { ranked, tied } = rankGroup(teams, ms);
  const comp = typeOf.get(teams[0]) === '競技組';
  ranked.forEach((name, idx) => {
    qualRows.push({
      no: roster.find((t) => t.name === name).no, name, group: code, rank: idx + 1,
      tier: idx < 2 ? (comp ? '白金' : '白銀') : (comp ? '黃金' : '青銅'),
      tied: tied.has(name)
    });
  });
});
if (qualRows.length !== 100) throw new Error(`QUAL_ROWS:${qualRows.length}/100`);

const seeds = {};
for (const key of TIER_KEYS) seeds[key] = seedsFor(key, qualRows);

// ── ② 淘汰賽 132 場：逐場推導 → 生分數 → 算勝方 → 再推下一場 ──
const results = {};
const rowOf = new Map(KNOCK_NOS.map((no, i) => [no, i + 2]));
let progress = true;
while (progress) {
  progress = false;
  const { pairs } = deriveAll(topology, seeds, results);
  for (const no of KNOCK_NOS) {
    if (results[no]) continue;
    const ab = pairs[no];
    if (!ab) continue;
    const idx = KNOCK_NOS.indexOf(no);
    const score = scoreFor(RUN_ID, `knockout-${idx + 1}`);
    assertLegalScore(score);
    const [a, b] = ab;
    results[no] = { a, b, sa: score[0], sb: score[1], winner: score[0] > score[1] ? a : b };
    progress = true;
  }
}
const missing = KNOCK_NOS.filter((no) => !results[no]);
if (missing.length) throw new Error(`淘汰賽推導卡住，未解出 ${missing.length} 場：${missing.slice(0, 8).join(',')}`);

// ── ③ 曜請 28 場（隊伍賽前預填，只補分數）────────────────────
const yao = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'dataset.json'), 'utf8')).yao;
const invitational = yao.map((p, i) => {
  const score = scoreFor(RUN_ID, `invitational-${i + 1}`);
  assertLegalScore(score);
  return { n: p.n, a: p.a, b: p.b, sa: score[0], sb: score[1] };
});

// ── ④ 預期的止步與名次分（＝ 6_積分總表 應該算出的東西）────────
const PLACE = {
  競技組: { 冠軍: 100, 亞軍: 80, 季軍: 60, 殿軍: 60, 八強止步: 0, 複賽止步: 40, 初賽止步: 0 },
  休閒組: { 冠軍: 100, 亞軍: 80, 季軍: 60, 殿軍: 60, 八強止步: 40, 複賽止步: 20, 初賽止步: 0 }
};
const BASE = { 白金: 300, 黃金: 200, 白銀: 100, 青銅: 0 };
const stop = new Map();
const setStop = (name, s) => { if (name) stop.set(name, s); };

for (const key of TIER_KEYS) {
  const M = topology.MNO[key];
  const meta = TIER_META[key];
  const loser = (no) => (results[no].winner === results[no].a ? results[no].b : results[no].a);
  M.pre.forEach((no) => setStop(loser(no), '初賽止步'));
  if (meta.type === 'comp') {
    [M.rrA, M.rrB].forEach((nos) => {
      const teams = [...new Set(nos.flatMap((no) => [results[no].a, results[no].b]))];
      const ms = nos.map((no) => ({ ...results[no], done: true }));
      rankGroup(teams, ms).ranked.forEach((name, i) => { if (i >= 2) setStop(name, '複賽止步'); });
    });
  } else {
    const triTeams = [...new Set(M.tri.flatMap((no) => [results[no].a, results[no].b]))];
    const triMs = M.tri.map((no) => ({ ...results[no], done: true }));
    rankGroup(triTeams, triMs).ranked.forEach((name, i) => { if (i >= 2) setStop(name, '複賽止步'); });
    M.ko.forEach((no) => setStop(loser(no), '複賽止步'));
    M.qf.forEach((no) => setStop(loser(no), '八強止步'));
  }
  setStop(results[M.final].winner, '冠軍');
  setStop(loser(M.final), '亞軍');
  setStop(results[M.third].winner, '季軍');
  setStop(loser(M.third), '殿軍');
}

const expected = roster.map((t) => {
  if (t.type === '曜請組') return { no: t.no, name: t.name, club: t.club, type: t.type, tier: '曜請', stop: '—', base: 0, place: 0, total: 0 };
  const q = qualRows.find((r) => r.name === t.name);
  const s = stop.get(t.name) || '—';
  const base = BASE[q.tier];
  const place = PLACE[t.type][s] ?? 0;
  return { no: t.no, name: t.name, club: t.club, type: t.type, tier: q.tier, rank: q.rank, stop: s, base, place, total: base + place };
});
const clubTotals = {};
expected.forEach((e) => { if (e.type !== '曜請組') clubTotals[e.club] = (clubTotals[e.club] || 0) + e.total; });

// ── ⑤ 輸出 ────────────────────────────────────────────────────
const payload = {
  run_id: RUN_ID,
  qual: Object.entries(qual).map(([n, m]) => ({ n: Number(n), row: Number(n) + 1, sa: m.sa, sb: m.sb })),
  knockout: KNOCK_NOS.map((no) => ({ n: no, row: rowOf.get(no), a: results[no].a, b: results[no].b, sa: results[no].sa, sb: results[no].sb, winner: results[no].winner })),
  invitational: invitational.map((m, i) => ({ n: m.n, row: i + 2, sa: m.sa, sb: m.sb })),
  expected, clubTotals,
  qualTiers: Object.fromEntries(qualRows.map((r) => [r.name, r.tier])),
  tiedGroups: qualRows.filter((r) => r.tied).map((r) => `${r.group} ${r.name}`)
};
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);

const dist = {};
expected.forEach((e) => { dist[e.stop] = (dist[e.stop] || 0) + 1; });
console.log(`✅ 離線模擬完成 run_id=${RUN_ID}`);
console.log(`   資格賽 ${payload.qual.length} · 淘汰賽 ${payload.knockout.length} · 曜請 ${payload.invitational.length}　合計 ${payload.qual.length + payload.knockout.length + payload.invitational.length}`);
console.log(`   止步分布：${Object.entries(dist).map(([k, v]) => `${k}×${v}`).join('  ')}`);
console.log(`   名次分非 0 的隊伍：${expected.filter((e) => e.place > 0).length} 隊`);
console.log(`   球團總分：${Object.entries(clubTotals).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${v}`).join(' · ')}`);
if (payload.tiedGroups.length) console.log(`   ⚠️ 資格賽三隊以上同勝場同失分率（現場需抽籤）：${payload.tiedGroups.join('、')}`);
console.log(`   → ${OUT}`);
