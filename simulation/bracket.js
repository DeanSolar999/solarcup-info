'use strict';

/* 淘汰賽晉級推導
   ────────────────────────────────────────────────────────────
   為什麼需要這一支：
   後端 `4_淘汰賽成績` 的 J/L（隊A隊名／隊B隊名）是賽務當天現場抽籤後手填的，
   系統裡沒有任何一段程式在推導晉級。原本的模擬 plan 只寫 M/N（分數），
   於是 132 場淘汰賽會變成「有分數、沒隊伍」——I/K 編號反查回傳空、O 勝方回傳空、
   `6_積分總表` 的 COUNTIFS 全部數到 0、止步一律「—」、名次分一律 0。
   整場演練會安靜地跑完，卻一格積分鏈路都沒驗到。

   賽程拓撲（哪一場屬於哪個五角形、哪些場次是三角循環）唯一的事實來源是
   `bracket-tree.html` 的 MNO / RR_PAIRS / TRI_PAIRS。這裡直接解析該檔，
   不另外抄一份，避免兩邊漂移。解析失敗一律 throw（fail-closed）。

   晉級規則刻意與前端 buildTier() 逐條對齊，因為演練要先驗「一致的happy path」；
   前後端分歧屬於另一種要刻意注入的測試，不在這支的職責內。 */

const fs = require('node:fs');
const path = require('node:path');

const TIER_KEYS = Object.freeze(['plat', 'gold', 'silver', 'bronze']);
// 級別在 `4_淘汰賽成績` D 欄與 `3_資格賽積分榜` K 欄的實際字面值不同：
// 淘汰賽用「銀／銅」，積分榜的自動晉級用「白銀／青銅」。
const TIER_META = Object.freeze({
  plat: { type: 'comp', sheetTier: '白金', qualTier: '白金', size: 20 },
  gold: { type: 'comp', sheetTier: '黃金', qualTier: '黃金', size: 20 },
  silver: { type: 'cas', sheetTier: '銀', qualTier: '白銀', size: 30 },
  bronze: { type: 'cas', sheetTier: '銅', qualTier: '青銅', size: 30 }
});

// ── 解析 bracket-tree.html 的拓撲常數 ─────────────────────────
function extractObjectLiteral(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`TOPOLOGY_MISSING:${declaration}`);
  let i = start + declaration.length;
  while (i < source.length && source[i] !== '{' && source[i] !== '[') i += 1;
  if (i >= source.length) throw new Error(`TOPOLOGY_MALFORMED:${declaration}`);
  const openChar = source[i];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  for (let j = i; j < source.length; j += 1) {
    if (source[j] === openChar) depth += 1;
    else if (source[j] === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  throw new Error(`TOPOLOGY_UNBALANCED:${declaration}`);
}

// 去掉行註解後，只允許「識別字、數字、括號、逗號、冒號、空白」，
// 確保 eval 的對象純粹是資料而非程式碼。
function safeLiteral(text) {
  const stripped = text.replace(/\/\/[^\n]*/g, '');
  if (!/^[\sA-Za-z0-9_{}[\],:]*$/u.test(stripped)) throw new Error('TOPOLOGY_UNSAFE_LITERAL');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${stripped});`)();
}

function loadTopology(htmlPath) {
  const file = htmlPath || path.join(__dirname, '..', 'bracket-tree.html');
  const source = fs.readFileSync(file, 'utf8');
  const topology = {
    MNO: safeLiteral(extractObjectLiteral(source, 'const MNO=')),
    RR_PAIRS: safeLiteral(extractObjectLiteral(source, 'const RR_PAIRS=')),
    TRI_PAIRS: safeLiteral(extractObjectLiteral(source, 'const TRI_PAIRS='))
  };
  assertTopology(topology);
  return topology;
}

function completeRoundRobin(pairs, n) {
  const seen = new Set(pairs.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
  return seen.size === (n * (n - 1)) / 2 && pairs.every(([a, b]) => a >= 0 && b < n && a !== b);
}

function assertTopology({ MNO, RR_PAIRS, TRI_PAIRS }) {
  if (!completeRoundRobin(RR_PAIRS, 5)) throw new Error('TOPOLOGY_RR_PAIRS_NOT_COMPLETE');
  if (!completeRoundRobin(TRI_PAIRS, 3)) throw new Error('TOPOLOGY_TRI_PAIRS_NOT_COMPLETE');
  const counts = { plat: 34, gold: 34, silver: 32, bronze: 32 };
  let total = 0;
  for (const key of TIER_KEYS) {
    const M = MNO[key];
    if (!M) throw new Error(`TOPOLOGY_TIER_MISSING:${key}`);
    const meta = TIER_META[key];
    const nos = meta.type === 'comp'
      ? [...M.pre, ...M.rrA, ...M.rrB, ...M.sf, M.final, M.third]
      : [...M.pre, ...M.tri, ...M.ko, ...M.qf, ...M.sf, M.final, M.third];
    if (nos.length !== counts[key]) throw new Error(`TOPOLOGY_COUNT:${key}=${nos.length}/${counts[key]}`);
    if (new Set(nos).size !== nos.length) throw new Error(`TOPOLOGY_DUPLICATE_MATCH:${key}`);
    if (M.pre.length !== meta.size / 2) throw new Error(`TOPOLOGY_PRE_SIZE:${key}`);
    total += nos.length;
  }
  if (total !== 132) throw new Error(`TOPOLOGY_TOTAL:${total}/132`);
}

// ── 循環賽名次 ────────────────────────────────────────────────
// 與 tournament-data.js 的 rankGroup 同一套規則：
// 勝場 → 失分率（該循環總得÷總失）→ 兩隊對戰勝負 → 原始序位。
// 三隊以上同勝場同失分率時，官方規則是抽籤；這裡退回原始序位並標記 tied，
// 讓演練報告能指出「現場會需要抽籤」的位置。
function rankGroup(teams, matches) {
  const EPS = 1e-9;
  const order = new Map();
  const stat = new Map();
  teams.forEach((name, index) => {
    order.set(name, index);
    stat.set(name, { w: 0, gf: 0, ga: 0 });
  });
  matches.forEach((m) => {
    if (!m || !m.done) return;
    const A = stat.get(m.a); const B = stat.get(m.b);
    if (!A || !B) return;
    A.gf += m.sa; A.ga += m.sb; B.gf += m.sb; B.ga += m.sa;
    if (m.sa > m.sb) A.w += 1; else B.w += 1;
  });
  const ratio = (name) => {
    const s = stat.get(name);
    return s.ga > 0 ? Math.min(s.gf / s.ga, 999) : 999;
  };
  const head = (x, y) => {
    const m = matches.find((mm) => mm && mm.done && ((mm.a === x && mm.b === y) || (mm.a === y && mm.b === x)));
    if (!m) return 0;
    const winner = m.sa > m.sb ? m.a : m.b;
    return winner === x ? -1 : 1;
  };
  const ranked = [...teams].sort((x, y) => {
    const dw = stat.get(y).w - stat.get(x).w;
    if (dw) return dw;
    const dr = ratio(y) - ratio(x);
    if (Math.abs(dr) > EPS) return dr;
    return order.get(x) - order.get(y);
  });
  const tied = new Set();
  let i = 0;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && stat.get(ranked[j]).w === stat.get(ranked[i]).w
      && Math.abs(ratio(ranked[j]) - ratio(ranked[i])) <= EPS) j += 1;
    const size = j - i;
    if (size === 2) {
      if (head(ranked[i], ranked[i + 1]) > 0) [ranked[i], ranked[i + 1]] = [ranked[i + 1], ranked[i]];
    } else if (size > 2) {
      for (let k = i; k < j; k += 1) tied.add(ranked[k]);
    }
    i = j;
  }
  return { ranked, tied };
}

// ── 種子序 ────────────────────────────────────────────────────
// 白金＝各組第 1、黃金＝各組第 2（休閒同理），因此同一級別內只有兩種組內排名。
// 直接照編號排會讓第一輪變成「第 1 名互打、第 2 名互打」，所以交錯成
// 1st,2nd,1st,2nd…，配對 seeds[2i] vs seeds[2i+1] 就是第 1 名對第 2 名。
// 這是模擬用的假抽籤，不代表現場實際籤運。
function seedsFor(tierKey, qualRows) {
  const meta = TIER_META[tierKey];
  const mine = qualRows.filter((r) => r.tier === meta.qualTier);
  if (mine.length !== meta.size) throw new Error(`SEED_SIZE:${tierKey}=${mine.length}/${meta.size}`);
  const byRank = new Map();
  mine.forEach((r) => {
    if (!byRank.has(r.rank)) byRank.set(r.rank, []);
    byRank.get(r.rank).push(r);
  });
  [...byRank.values()].forEach((list) => list.sort((a, b) => a.no - b.no));
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const seeds = [];
  const depth = Math.max(...ranks.map((r) => byRank.get(r).length));
  for (let i = 0; i < depth; i += 1) {
    ranks.forEach((r) => { const row = byRank.get(r)[i]; if (row) seeds.push(row.name); });
  }
  if (seeds.length !== meta.size) throw new Error(`SEED_BUILD:${tierKey}`);
  return seeds;
}

// ── 逐場推導 ──────────────────────────────────────────────────
/* results：已知的雲端結果，形如 { 場次: {a,b,winner} }。
   winner 直接採用後端 `4_淘汰賽成績` O 欄公式算出的隊名——
   這正是「逐場回讀雲端」的意義：晉級是拿後端算的勝方往下推，
   而不是拿腳本自己記的分數推。兩者不一致時由呼叫端記為 finding，不中斷。

   回傳 { 場次: [隊A, 隊B] }，只含「兩隊都已確定」的場次。 */
function deriveTier(tierKey, topology, seeds, results) {
  const M = topology.MNO[tierKey];
  const meta = TIER_META[tierKey];
  const out = {};
  const win = (no) => (results[no] && results[no].winner) || null;
  const loss = (no) => {
    const r = results[no];
    if (!r || !r.winner || !r.a || !r.b) return null;
    return r.winner === r.a ? r.b : r.a;
  };
  const emit = (no, a, b) => { if (no != null && a && b) out[no] = [a, b]; };

  // 初賽：種子序相鄰配對，敗方該級別結束（初賽止步）
  M.pre.forEach((no, i) => emit(no, seeds[i * 2], seeds[i * 2 + 1]));
  const adv = M.pre.map((no) => win(no));

  let semiIn = null;

  if (meta.type === 'comp') {
    // 複賽：初賽勝方依場次順序落座 A1–A5／B1–B5，兩個五角各自全循環
    const groups = [adv.slice(0, 5), adv.slice(5, 10)];
    const groupNos = [M.rrA, M.rrB];
    const standings = [];
    groups.forEach((g, gi) => {
      topology.RR_PAIRS.forEach((p, k) => emit(groupNos[gi][k], g[p[0]], g[p[1]]));
      if (g.every(Boolean)) {
        const ms = topology.RR_PAIRS.map((p, k) => {
          const r = results[groupNos[gi][k]];
          return r && r.winner ? { a: g[p[0]], b: g[p[1]], sa: r.sa, sb: r.sb, done: true } : null;
        }).filter(Boolean);
        standings.push(ms.length === topology.RR_PAIRS.length ? rankGroup(g, ms) : null);
      } else standings.push(null);
    });
    // 準決賽配對 A1×B2、B1×A2
    if (standings[0] && standings[1]) {
      semiIn = [standings[0].ranked[0], standings[1].ranked[1], standings[1].ranked[0], standings[0].ranked[1]];
    }
    out._standings = standings;
  } else {
    // 複賽：初賽勝方前 3 走三角循環取 2，其餘 12 隊單淘汰取 6，合計 8 強
    const tri = adv.slice(0, 3);
    const koPool = adv.slice(3, 15);
    topology.TRI_PAIRS.forEach((p, k) => emit(M.tri[k], tri[p[0]], tri[p[1]]));
    M.ko.forEach((no, i) => emit(no, koPool[i * 2], koPool[i * 2 + 1]));
    let triTop2 = null;
    if (tri.every(Boolean)) {
      const ms = topology.TRI_PAIRS.map((p, k) => {
        const r = results[M.tri[k]];
        return r && r.winner ? { a: tri[p[0]], b: tri[p[1]], sa: r.sa, sb: r.sb, done: true } : null;
      }).filter(Boolean);
      if (ms.length === topology.TRI_PAIRS.length) {
        const rk = rankGroup(tri, ms);
        triTop2 = [rk.ranked[0], rk.ranked[1]];
        out._triRank = rk;
      }
    }
    const koWin = M.ko.map((no) => win(no));
    // 8 強席次：三角前二拆到兩端，避免同循環兩隊立刻碰頭
    if (triTop2) {
      const eight = [triTop2[0], ...koWin, triTop2[1]];
      M.qf.forEach((no, i) => emit(no, eight[i * 2], eight[i * 2 + 1]));
      if (eight.every(Boolean)) out._eight = eight;
    }
    const qfW = M.qf.map((no) => win(no));
    if (qfW.every(Boolean)) semiIn = qfW;
  }

  if (semiIn && semiIn.every(Boolean)) {
    M.sf.forEach((no, i) => emit(no, semiIn[i * 2], semiIn[i * 2 + 1]));
    const sfW = M.sf.map((no) => win(no));
    const sfL = M.sf.map((no) => loss(no));
    emit(M.final, sfW[0], sfW[1]);      // 冠亞賽＝兩場準決賽的勝方
    emit(M.third, sfL[0], sfL[1]);      // 季殿賽＝兩場準決賽的敗方
  }
  return out;
}

// `4_淘汰賽成績` 的列順序＝場次由小到大（見 build_backend_v2.py 的 sorted(knock)），
// 因此第 i 場淘汰賽對應第 2+i 列。plan 要靠這個對照才能把隊名寫到正確的列。
function knockoutNumbers(topology) {
  const nos = [];
  for (const key of TIER_KEYS) {
    const M = topology.MNO[key];
    nos.push(...M.pre, ...(M.rrA || []), ...(M.rrB || []), ...(M.tri || []),
      ...(M.ko || []), ...(M.qf || []), ...M.sf, M.final, M.third);
  }
  nos.sort((a, b) => a - b);
  if (nos.length !== 132 || new Set(nos).size !== 132) throw new Error('KNOCKOUT_NUMBERS_INVALID');
  return nos;
}

function deriveAll(topology, seedsByTier, results) {
  const pairs = {};
  const meta = {};
  for (const key of TIER_KEYS) {
    const d = deriveTier(key, topology, seedsByTier[key], results);
    for (const [no, ab] of Object.entries(d)) {
      if (no.startsWith('_')) { meta[`${key}${no}`] = ab; continue; }
      pairs[no] = ab;
    }
  }
  return { pairs, meta };
}

module.exports = {
  TIER_KEYS, TIER_META, loadTopology, assertTopology, knockoutNumbers,
  rankGroup, seedsFor, deriveTier, deriveAll
};
