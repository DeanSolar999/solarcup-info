'use strict';

/* site-engine.test.js — site-engine 回歸測試（離線、無雲端、無網路）
   ════════════════════════════════════════════════════════════════
   【由來】原本的重放自測「executor selftest ⑦」只活在 finalrun 產物裡
   （scratchpad 一次性輸出），程式庫 grep 不到 selftest ＝ 證據鏈斷點：
   宣稱驗過、但任何人都無法從 repo 重跑。本檔把它落地成常駐回歸測試，
   `npm test`（node --test *.test.js）自動納入，selftest 一詞就此退役。

   【素材全在本機】bracket-tree.html（現檔）＋ tournament-data.js（名冊）
   ＋ 測試內程式化生成的合成快照。不讀雲端、不寫雲端、不發網路請求。

   【涵蓋】
     ① loadTopology()  對現行 bracket-tree.html 通過（132 場唯一、逐輪數量）
     ② replayVerify()  全 132 場完賽合成快照 → doneCount 132、findings 0、
                       四級冠亞季殿與名次分皆產出
     ③ 毒快照四種 finding 各一：ILLEGAL_SCORE（30:29／21:21 平手）、
                       NAME_NOT_ROSTER（幽靈隊名）、SELF_MATCH（自己打自己）
     ④ deriveSeating() 墓碑仍在（呼叫即 throw）
     ⑤ bracket.js      OFFICIAL_RR_PAIRS／OFFICIAL_TRI_PAIRS 形狀與完整循環
     ⑥ vm 隔離現況釘樁 ＋ 文件必須寫明「node:vm 不是安全邊界」 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const siteEngine = require('./site-engine');
const bracket = require('./bracket');

const SITE = path.join(__dirname, '..');
const SolarCupData = require(path.join(SITE, 'tournament-data.js')).SolarCupData;

// 官方表定循環配對順序（與 bracket.js 的 OFFICIAL_* 同源；合成快照照這個順序鋪場次）
const RR_ORDER = [[0, 1], [2, 3], [1, 4], [0, 3], [2, 4], [1, 3], [0, 4], [1, 2], [0, 2], [3, 4]];
const TRI_ORDER = [[0, 1], [1, 2], [0, 2]];
const TIER_KEYS = ['plat', 'gold', 'silver', 'bronze'];
const COMP_KEYS = new Set(['plat', 'gold']);

/* ── 合成快照產生器 ───────────────────────────────────────────────
   造一份「全 132 場完賽」的雲端快照：每場 A 方 21 分必勝、B 方 0–19。
   勝方一路往下鋪成自洽的晉級樹（初賽勝方 → 循環 → 8 強 → 準決 →
   決賽／季軍賽），隊名全取自本機名冊，因此乾淨快照應該 0 findings。
   刻意讓每組戰績呈階梯（4/3/2/1/0 勝），避開並列待判定。 */
function buildFullSnapshot() {
  const topology = siteEngine.loadTopology();
  const all = SolarCupData.buildAllTeams(null).teams;
  // 先取非曜請的正賽隊伍；不足 100 才用其餘名冊隊名補齊（名冊改版時不至於整份測試崩掉）
  const roster = [...new Set([
    ...all.filter((t) => t.track !== '曜請').map((t) => t.label),
    ...all.map((t) => t.label)
  ])];
  assert.ok(roster.length >= 100, `名冊隊名不足 100（${roster.length}）——合成快照無法鋪滿 100 個席位`);

  const snapshot = {};
  let cursor = 0;
  const take = (n) => roster.slice(cursor, (cursor += n));
  // sa 固定 21、sb 由場次編號決定（151–310 → 0–19），保證每場都是合法的 21 分單局
  const put = (no, a, b) => { snapshot[String(no)] = { a, b, sa: 21, sb: no % 20, done: true }; };

  for (const key of TIER_KEYS) {
    const M = topology.MNO[key];
    const comp = COMP_KEYS.has(key);
    const teams = take(comp ? 20 : 30);
    const preWinners = [];
    M.pre.forEach((no, i) => { put(no, teams[2 * i], teams[2 * i + 1]); preWinners.push(teams[2 * i]); });

    if (comp) {
      const groupA = preWinners.slice(0, 5);
      const groupB = preWinners.slice(5, 10);
      M.rrA.forEach((no, i) => put(no, groupA[RR_ORDER[i][0]], groupA[RR_ORDER[i][1]]));
      M.rrB.forEach((no, i) => put(no, groupB[RR_ORDER[i][0]], groupB[RR_ORDER[i][1]]));
      put(M.sf[0], groupA[0], groupB[1]);
      put(M.sf[1], groupB[0], groupA[1]);
      put(M.final, groupA[0], groupB[0]);   // 冠 groupA[0]／亞 groupB[0]
      put(M.third, groupB[1], groupA[1]);   // 季 groupB[1]／殿 groupA[1]
    } else {
      const tri = preWinners.slice(0, 3);
      const rest = preWinners.slice(3);
      M.tri.forEach((no, i) => put(no, tri[TRI_ORDER[i][0]], tri[TRI_ORDER[i][1]]));
      const koWinners = [];
      M.ko.forEach((no, i) => { put(no, rest[2 * i], rest[2 * i + 1]); koWinners.push(rest[2 * i]); });
      const eight = [tri[0], tri[1], ...koWinners];
      put(M.qf[0], eight[0], eight[2]);
      put(M.qf[1], eight[1], eight[3]);
      put(M.qf[2], eight[4], eight[5]);
      put(M.qf[3], eight[6], eight[7]);
      put(M.sf[0], eight[0], eight[6]);
      put(M.sf[1], eight[1], eight[4]);
      put(M.final, eight[0], eight[1]);     // 冠 eight[0]／亞 eight[1]
      put(M.third, eight[6], eight[4]);     // 季 eight[6]／殿 eight[4]
    }
  }
  assert.equal(cursor, 100, '四級應恰好用掉 20+20+30+30＝100 個名冊席位');
  assert.equal(Object.keys(snapshot).length, 132);
  return { snapshot, topology };
}

// 毒快照：在乾淨快照上只動一場，其餘不變
function poison(mutate) {
  const { snapshot } = buildFullSnapshot();
  mutate(snapshot);
  return siteEngine.replayVerify(snapshot).findings;
}

// ── ① loadTopology() 對現行 bracket-tree.html 通過 ─────────────────
test('loadTopology：現行 bracket-tree.html 摘取成功，132 場唯一、逐輪數量正確', () => {
  const topology = siteEngine.loadTopology();

  // TIERS／SEATS 是 vm context 內建立的陣列（跨 realm，prototype 不同 host Array），
  // deepStrictEqual 會因此判不相等——先 spread 回 host realm 再比。
  const tiers = [...topology.tiers];
  assert.deepEqual(tiers.map((t) => t.key), TIER_KEYS);
  assert.deepEqual(tiers.map((t) => t.name), ['白金', '黃金', '白銀', '青銅']);
  assert.deepEqual(tiers.map((t) => t.type), ['comp', 'comp', 'cas', 'cas']);
  assert.deepEqual([...topology.SEATS], ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']);

  // 逐輪數量（競技 34 場／休閒 32 場）
  const expected = {
    plat: { pre: 10, rrA: 10, rrB: 10, sf: 2 },
    gold: { pre: 10, rrA: 10, rrB: 10, sf: 2 },
    silver: { pre: 15, tri: 3, ko: 6, qf: 4, sf: 2 },
    bronze: { pre: 15, tri: 3, ko: 6, qf: 4, sf: 2 }
  };
  let total = 0;
  for (const key of TIER_KEYS) {
    const M = topology.MNO[key];
    for (const [round, count] of Object.entries(expected[key])) {
      assert.equal(M[round].length, count, `${key}.${round} 應有 ${count} 場`);
      total += count;
    }
    assert.ok(Number.isInteger(M.final) && Number.isInteger(M.third), `${key} 決賽／季軍賽場次缺漏`);
    total += 2;
    // 競技無 8 強、休閒無五角雙組——結構互斥，錯置代表 HTML 改版沒同步
    assert.equal(COMP_KEYS.has(key), M.rrA !== undefined);
    assert.equal(COMP_KEYS.has(key), M.qf === undefined);
  }
  assert.equal(total, 132);

  assert.equal(topology.knockoutNos.length, 132);
  assert.equal(new Set(topology.knockoutNos).size, 132, '132 場場次編號必須唯一');
  assert.ok(topology.knockoutNos.every((n) => Number.isInteger(n) && n >= 151 && n <= 310));
  // 淘汰賽 132 場與曜請賽 28 場恰好切滿 151–310，不重疊、不留白
  const invite = new Set((SolarCupData.INVITE_SCHEDULE || []).map((sc) => sc[0]));
  assert.equal(invite.size, 28);
  assert.equal(new Set([...topology.knockoutNos, ...invite]).size, 160);
});

// ── ② 全 132 場完賽合成快照 → doneCount 132、findings 0、四級冠亞季殿 ──
test('replayVerify：合成全 132 場完賽快照 → doneCount 132、零 findings', () => {
  const { snapshot } = buildFullSnapshot();
  const { view, findings } = siteEngine.replayVerify(snapshot);

  assert.deepEqual(findings, [], `乾淨快照不該有任何 finding：${JSON.stringify(findings)}`);
  assert.equal(view.doneCount, 132);
});

test('replayVerify：四級冠亞季殿皆產出，且名次分／止步階段正確', () => {
  const { snapshot, topology } = buildFullSnapshot();
  const { view } = siteEngine.replayVerify(snapshot);

  for (const key of TIER_KEYS) {
    const medal = view.medals[key];
    const M = topology.MNO[key];
    const final = snapshot[String(M.final)];
    const third = snapshot[String(M.third)];

    assert.equal(medal.champion, final.a, `${key} 冠軍應為決賽勝方`);
    assert.equal(medal.runnerUp, final.b, `${key} 亞軍應為決賽敗方`);
    assert.equal(medal.third, third.a, `${key} 季軍應為季軍賽勝方`);
    assert.deepEqual(medal.thirdPair, [third.a, third.b], `${key} 季殿賽對戰組合`);
    for (const [slot, label] of Object.entries(medal)) {
      if (slot !== 'thirdPair') assert.ok(label, `${key}.${slot} 不得為 null（全完賽快照）`);
    }

    // 名次分：冠 100／亞 80／季殿 60（殿軍＝季軍賽敗方）
    assert.deepEqual(view.points.get(medal.champion), { base: 0, placePts: 100, stage: '冠軍' });
    assert.deepEqual(view.points.get(medal.runnerUp), { base: 0, placePts: 80, stage: '亞軍' });
    assert.deepEqual(view.points.get(medal.third), { base: 0, placePts: 60, stage: '四強 · 季軍' });
    assert.deepEqual(view.points.get(third.b), { base: 0, placePts: 60, stage: '四強 · 殿軍' });
  }

  // 100 支上場隊伍全部進 REG 並拿到名次分紀錄
  assert.equal(view.points.size, 100);
});

test('replayVerify：競技五角／休閒三角名次榜完整，階梯戰績無並列待判定', () => {
  const { snapshot } = buildFullSnapshot();
  const { view } = siteEngine.replayVerify(snapshot);

  assert.deepEqual(Object.keys(view.rr).sort(), ['gold.rrA', 'gold.rrB', 'plat.rrA', 'plat.rrB']);
  for (const [group, board] of Object.entries(view.rr)) {
    assert.equal(board.ranked.length, 5, `${group} 五角循環應有 5 隊`);
    assert.equal(new Set(board.ranked).size, 5);
    assert.deepEqual(board.tied, [], `${group} 階梯戰績不該出現並列`);
    assert.equal(board.pendingDecision, false);
  }

  assert.deepEqual(Object.keys(view.tri).sort(), ['bronze', 'silver']);
  for (const [key, board] of Object.entries(view.tri)) {
    assert.equal(board.ranked.length, 3, `${key} 三角循環應有 3 隊`);
    assert.equal(new Set(board.ranked).size, 3);
    assert.deepEqual(board.tied, []);
    assert.equal(board.pendingDecision, false);
  }
});

// ── ③ 毒快照四種 finding 各一 ─────────────────────────────────────
test('毒快照：非法比分 30:29 → ILLEGAL_SCORE', () => {
  const findings = poison((s) => { s['151'].sa = 30; s['151'].sb = 29; });
  assert.deepEqual(findings, [{ code: 'ILLEGAL_SCORE', no: 151, sa: 30, sb: 29 }]);
});

test('毒快照：平手 21:21 → ILLEGAL_SCORE', () => {
  const findings = poison((s) => { s['151'].sa = 21; s['151'].sb = 21; });
  assert.deepEqual(findings, [{ code: 'ILLEGAL_SCORE', no: 151, sa: 21, sb: 21 }]);
});

test('毒快照：幽靈隊名 → NAME_NOT_ROSTER', () => {
  const ghost = '幽靈隊伍・不在名冊';
  assert.ok(!SolarCupData.buildAllTeams(null).teams.some((t) => t.label === ghost));
  // 換掉 151 場的敗方，幽靈名不會往下游擴散，findings 應恰好一筆
  const findings = poison((s) => { s['151'].b = ghost; });
  assert.deepEqual(findings, [{ code: 'NAME_NOT_ROSTER', label: ghost }]);
});

test('毒快照：自己打自己 → SELF_MATCH', () => {
  const { snapshot } = buildFullSnapshot();
  const label = snapshot['151'].a;
  const findings = poison((s) => { s['151'].b = s['151'].a; });
  assert.deepEqual(findings, [{ code: 'SELF_MATCH', no: 151, label }]);
});

// ── ④ deriveSeating 墓碑仍在 ───────────────────────────────────────
test('deriveSeating：結構推演已移除，呼叫即 throw 並指路備份', () => {
  assert.throws(() => siteEngine.deriveSeating(), /DERIVE_SEATING_REMOVED/);
  assert.throws(() => siteEngine.deriveSeating(), /site-engine-v1-structural\.js/);
});

// ── ⑤ bracket.js 官方配對常數結構 ─────────────────────────────────
test('bracket.js：OFFICIAL_RR_PAIRS／OFFICIAL_TRI_PAIRS 形狀正確且為完整循環', () => {
  const cases = [
    { pairs: bracket.OFFICIAL_RR_PAIRS, n: 5, len: 10, name: 'OFFICIAL_RR_PAIRS' },
    { pairs: bracket.OFFICIAL_TRI_PAIRS, n: 3, len: 3, name: 'OFFICIAL_TRI_PAIRS' }
  ];
  for (const { pairs, n, len, name } of cases) {
    assert.ok(Array.isArray(pairs), `${name} 應為陣列`);
    assert.equal(pairs.length, len, `${name} 應有 ${len} 組配對`);
    assert.ok(Object.isFrozen(pairs), `${name} 應為 frozen，避免被呼叫端就地改寫`);
    for (const pair of pairs) {
      assert.equal(pair.length, 2, `${name} 每組配對只能兩隊`);
      assert.ok(pair.every((i) => Number.isInteger(i) && i >= 0 && i < n), `${name} 索引須落在 0–${n - 1}`);
      assert.notEqual(pair[0], pair[1], `${name} 不得自己對自己`);
    }
    const undirected = new Set(pairs.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
    assert.equal(undirected.size, (n * (n - 1)) / 2, `${name} 須為 ${n} 隊完整循環、無重複配對`);
  }
  assert.deepEqual(bracket.OFFICIAL_RR_PAIRS.map((p) => [...p]), RR_ORDER);
  assert.deepEqual(bracket.OFFICIAL_TRI_PAIRS.map((p) => [...p]), TRI_ORDER);
});

test('bracket.js loadTopology：HTML 已無同名常數，配對事實由 OFFICIAL_* 承接', () => {
  const html = fs.readFileSync(path.join(SITE, 'bracket-tree.html'), 'utf8');
  assert.doesNotMatch(html, /const (?:RR|TRI)_PAIRS=/,
    'bracket-tree.html 若加回同名常數，bracket.js 會靜默改以 HTML 為準');
  const topology = bracket.loadTopology();
  assert.deepEqual(topology.RR_PAIRS, RR_ORDER);
  assert.deepEqual(topology.TRI_PAIRS, TRI_ORDER);
  assert.equal(bracket.knockoutNumbers(topology).length, 132);
});

// ── ⑥ vm 隔離現況：只擋意外，不是安全邊界 ────────────────────────
test('vm context：process／require／fetch／fs／module 皆不可達（防意外，非安全邊界）', () => {
  const probe = siteEngine.sandboxIsolationProbe();
  assert.equal(probe.isolated, true, `不該有全域洩漏：${JSON.stringify(probe.leaked)}`);
  for (const key of ['process', 'require', 'fetch', 'fs', 'module']) {
    assert.equal(probe.result[key], 'undefined', `${key} 應在 context 內不可達`);
  }
});

test('文件釘樁：檔頭明載 node:vm 不是安全邊界，且禁餵不可信程式碼', () => {
  const header = fs.readFileSync(path.join(__dirname, 'site-engine.js'), 'utf8').slice(0, 3000);
  assert.match(header, /不是安全邊界/, 'site-engine.js 檔頭不得再宣稱「真沙箱／安全沙箱」');
  assert.match(header, /this\.constructor\.constructor/, '檔頭須具名記載已知可行的逃逸手法');
  assert.match(header, /嚴禁餵入不可信/, '檔頭須寫死「不得餵入不可信來源程式碼」的禁令');

  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  assert.match(readme, /不是安全邊界/);
  assert.doesNotMatch(readme, /真沙箱|安全沙箱/, 'README 不得出現「真沙箱／安全沙箱」措辭');
});
