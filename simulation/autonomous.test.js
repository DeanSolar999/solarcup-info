'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fullPlan, pairedJitter, sameCells } = require('./lib');
const {
  buildScenarioPlan, SCENARIOS, assertCompletedScore, fixtureStats, findClubTieFixture, applyClubTieFixture,
  B_NOS, B_SCORES, C3_NOS, C3_SCORES, C5_NOS, C5_SCORES
} = require('./scenario-engine');
const { loadTopology } = require('./bracket');
const { DualSiteObserver, SITES } = require('./observer');
const { reportPayload } = require('./report');
const { SimulationRunner, EXPECTED_SPREADSHEET_ID, cellForNumber, backupEvidenceDigest } = require('./runner');
const { MockAdapter } = require('./mock-adapter');
const { ScriptedResolver } = require('./knockout-resolver');

const TEST_BACKUP_EVIDENCE = {
  backup_file_id: '15WHaxX9Qa-6-tw9XzQ-G0LgkzdxxGDbHqLv8dZ048RM',
  source_sheet_id: EXPECTED_SPREADSHEET_ID, created_at: '2026-08-10T09:31:26.569Z',
  verified_at: new Date().toISOString(), title: '曜日盃TWO_正式資料庫_模擬前備份_source-1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA_2026-08-10T17-31+08', size: 76499
};
TEST_BACKUP_EVIDENCE.sha = backupEvidenceDigest(TEST_BACKUP_EVIDENCE);
process.env.SOLAR_CUP_BACKUP_EVIDENCE = JSON.stringify(TEST_BACKUP_EVIDENCE);

test('A–K scenario compiler：310 場、各場 completed 無平手，F 僅標記受控 incomplete', () => {
  const plan = buildScenarioPlan('autonomous-test', fullPlan());
  assert.equal(plan.length, 310);
  for (const key of Object.keys(SCENARIOS)) assert.ok(plan.some((match) => match.scenario === key), `missing ${key}`);
  for (const match of plan) assert.doesNotThrow(() => assertCompletedScore(match.score));
  const f = plan.find((match) => match.scenario === 'F');
  assert.deepEqual(f.incomplete.score, [0, 0]); assert.equal(f.incomplete.maxSeconds, 120);
  assert.ok(plan.find((match) => match.scenario === 'A').venuePace);
  assert.ok(plan.some((match) => match.scenario === 'C' && match.c2));
});

test('B/C fixtures：固定比分會形成指定三隊與五隊同值，且 21:20 合法', () => {
  const plan = buildScenarioPlan('fixture-scores');
  assert.deepEqual(B_NOS.map((no) => plan.find((match) => match.no === no).score), B_SCORES);
  assert.deepEqual(C3_NOS.map((no) => plan.find((match) => match.no === no).score), C3_SCORES);
  assert.deepEqual(C5_NOS.map((no) => plan.find((match) => match.no === no).score), C5_SCORES);
  const statsFor = (nos) => {
    const matches = nos.map((no) => plan.find((match) => match.no === no));
    const teams = [...new Set(matches.flatMap((match) => [match.teamA, match.teamB]))];
    return fixtureStats(teams, matches.map((match) => ({ a: match.teamA, b: match.teamB, sa: match.score[0], sb: match.score[1] })));
  };
  const b = Object.values(statsFor(B_NOS)).filter((item) => item.wins === 2);
  assert.deepEqual(b.map((item) => [item.gf, item.ga]).sort(), [[52, 61], [61, 31], [62, 50]].sort());
  const c3 = Object.values(statsFor(C3_NOS)).filter((item) => item.wins === 2);
  assert.equal(c3.length, 3); assert.ok(c3.every((item) => item.gf === 53 && item.ga === 32));
  const teams = ['甲', '乙', '丙', '丁', '戊']; const pairs = loadTopology().RR_PAIRS;
  const c5 = fixtureStats(teams, pairs.map(([a, b], index) => ({ a: teams[a], b: teams[b], sa: C5_SCORES[index][0], sb: C5_SCORES[index][1] })));
  assert.ok(Object.values(c5).every((item) => item.wins === 2 && item.gf === 64 && item.ga === 64));
});

test('K bounded oracle：24 候選、最多兩次翻轉，回傳候選面內最小解', () => {
  const plan = buildScenarioPlan('k-search-explore');
  const fixture = findClubTieFixture(plan, { maxFlips: 2, requireDisjoint: true });
  assert.equal(fixture.candidateCount, 24); assert.ok(fixture.minimalFlips <= 2);
  assert.ok(fixture.expected.different.comps[0] !== fixture.expected.different.comps[1]);
  assert.equal(new Set([...fixture.expected.different.clubs, ...fixture.expected.joint.clubs]).size, 4);
});

test('paired jitter：25–35 秒、相鄰兩場 60 秒、310 場合計 9300 秒', () => {
  const values = pairedJitter(310, () => 0.2);
  assert.equal(values.reduce((sum, value) => sum + value, 0), 9300);
  values.forEach((value) => assert.ok(value >= 25 && value <= 35));
  for (let i = 0; i < values.length; i += 2) assert.equal(values[i] + values[i + 1], 60);
});

function fakeClockRunner(plan, adapter = new MockAdapter()) {
  const fs = require('node:fs');
  let clock = 0;
  const runner = new SimulationRunner({
    adapter, stateDir: fs.mkdtempSync('/private/tmp/scenario-gate-'),
    spreadsheetId: EXPECTED_SPREADSHEET_ID, plan, mode: 'dry-run', fast: false,
    allowedStages: ['qualification', 'knockout', 'invitational'], resolver: new ScriptedResolver(),
    now: () => clock, sleepFn: async (ms) => { clock += ms; }
  });
  return { runner, adapter, now: () => clock };
}

test('A 真實 gate：同 slot court 3 寫入時間早於 court 7', async () => {
  const source = buildScenarioPlan('scenario-a').filter((match) => match.scenario === 'A');
  assert.deepEqual(source.map((match) => match.schedule.ct), [3, 7]);
  const { runner } = fakeClockRunner(source);
  const manifest = await runner.snapshot('scenario-a');
  await runner.runMatchSequence(manifest, source, [30, 30]);
  assert.ok(manifest.runtime_evidence.write_times[source[0].id] < manifest.runtime_evidence.write_times[source[1].id]);
  assert.equal(manifest.assertion_evidence[source[0].id].status, 'pass');
  assert.equal(manifest.assertion_evidence[source[1].id].status, 'pass');
});

test('H 真實 gate：權威開幕空檔等待 25 分鐘且空檔中零寫入', async () => {
  const match = buildScenarioPlan('scenario-h').find((item) => item.scenario === 'H');
  const { runner, adapter, now } = fakeClockRunner([match]);
  const manifest = await runner.snapshot('scenario-h');
  await runner.runMatchSequence(manifest, [match], [30]);
  const evidence = manifest.assertion_evidence[match.id].assertions.find((item) => item.assertion === 'authoritative_opening_gap_no_writes');
  assert.equal(evidence.status, 'pass');
  assert.equal(evidence.requiredMs, 25 * 60 * 1000);
  assert.equal(evidence.writesDuringGap, 0);
  assert.ok(now() >= 25 * 60 * 1000);
  assert.equal(adapter.writeCount, 1);
});

test('I 真實 gate：同 slot 10 面場 serial await，首末 60 秒內且無並行', async () => {
  class TrackedAdapter extends MockAdapter {
    constructor() { super(); this.inFlight = 0; this.maxInFlight = 0; }
    async writeCells(values) {
      this.inFlight += 1; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await super.writeCells(values);
      this.inFlight -= 1;
    }
  }
  const group = buildScenarioPlan('scenario-i').filter((match) => match.scenario === 'I');
  assert.equal(group.length, 10); assert.equal(new Set(group.map((match) => match.schedule.s)).size, 1);
  const adapter = new TrackedAdapter();
  const { runner } = fakeClockRunner(group, adapter);
  const manifest = await runner.snapshot('scenario-i');
  await runner.runMatchSequence(manifest, group, pairedJitter(10, () => 0.2));
  const evidence = manifest.runtime_evidence.serial_groups[group[0].serialWindow.groupId];
  assert.equal(evidence.maxInFlight, 1); assert.ok(evidence.elapsedMs <= 60_000);
  assert.equal(adapter.maxInFlight, 1);
  assert.ok(group.every((match) => manifest.assertion_evidence[match.id].status === 'pass'));
});

test('J 真實 gate：prerequisite 未完成不寫 Final Four，完成後才解凍', async () => {
  const compiled = buildScenarioPlan('scenario-j');
  const final = compiled.find((match) => match.scenario === 'J');
  const [firstId, secondId] = final.finalFourGate.prerequisiteIds;
  const first = { ...compiled.find((match) => match.id === firstId), finalFourGate: null };
  const second = { ...compiled.find((match) => match.id === secondId), finalFourGate: null };
  const plan = [first, final, second];
  const { runner } = fakeClockRunner(plan);
  const manifest = await runner.snapshot('scenario-j');
  await runner.runMatchSequence(manifest, plan, [30, 30, 30]);
  const freeze = manifest.runtime_evidence.frozen_matches[final.id];
  assert.ok(freeze); assert.ok(freeze.unfreezedAt >= freeze.frozenAt);
  assert.ok(manifest.readback_evidence.writes[first.id]);
  assert.ok(manifest.readback_evidence.writes[second.id]);
  assert.ok(manifest.readback_evidence.writes[final.id]);
  assert.equal(manifest.assertion_evidence[final.id].status, 'pass');
  assert.deepEqual(manifest.checkpoint.completed, plan.map((match) => match.id));
});

test('G 反轉比分先持久化 alternate intent；反轉後取消仍可 exact restore', async () => {
  const match = buildScenarioPlan('reverse-intent').find((item) => item.scenario === 'G');
  const initial = Object.fromEntries(match.cells.map((ref, index) => [ref, cellForNumber(index + 7)]));
  class CancelAfterReverse extends MockAdapter {
    async writeCells(values) { await super.writeCells(values); if (this.writeCount === 1) runner.stopRequested = true; }
  }
  const adapter = new CancelAfterReverse(initial); const { runner } = fakeClockRunner([match], adapter);
  const manifest = await runner.snapshot('reverse-intent');
  await assert.rejects(() => runner.executeMatch(manifest, match), (error) => error.p0 === true && /CANCELLED/.test(error.message));
  assert.equal(manifest.in_flight.kind, 'REVERSED_THEN_CORRECT');
  assert.equal(manifest.in_flight.alternatePosts.length, 1);
  const restored = await runner.restore(manifest); assert.equal(restored.state, 'COMPLETE');
  assert.deepEqual(await adapter.readCells(manifest.allowlist), manifest.pre_image);
});

async function crashAfterFinalIntentBeforeWrite(scenario, runId) {
  const match = buildScenarioPlan(runId).find((item) => item.scenario === scenario);
  const initial = Object.fromEntries(match.cells.map((ref, index) => [ref, cellForNumber(index + 7)]));
  const adapter = new MockAdapter(initial); const { runner } = fakeClockRunner([match], adapter);
  const manifest = await runner.snapshot(runId); const durablePersist = runner.persist.bind(runner); let intents = 0;
  runner.persist = async (current) => {
    await durablePersist(current);
    if (current.in_flight?.match === match.id && ++intents === 2) throw new Error('CRASH_AFTER_FINAL_INTENT');
  };
  await assert.rejects(() => runner.executeMatch(manifest, match), /CRASH_AFTER_FINAL_INTENT/);
  assert.equal(manifest.in_flight.match, match.id);
  assert.equal(manifest.in_flight.alternatePosts.length, 1);
  assert.ok(!sameCells(await adapter.readCells(match.scoreCells || match.cells), manifest.pre_image));
  runner.persist = durablePersist;
  const restored = await runner.restore(manifest);
  assert.equal(restored.state, 'COMPLETE');
  assert.deepEqual(await adapter.readCells(manifest.allowlist), manifest.pre_image);
}

test('F crash boundary：final intent 已持久化、final write 前 crash，仍保留 0:0 alternate 並 exact restore', async () => {
  await crashAfterFinalIntentBeforeWrite('F', 'f-final-intent-crash');
});

test('G crash boundary：final intent 已持久化、final write 前 crash，仍保留 reversed alternate 並 exact restore', async () => {
  await crashAfterFinalIntentBeforeWrite('G', 'g-final-intent-crash');
});

test('雙站 observer：依 stage route 精確比對同一卡的場次、雙隊與比分', async () => {
  const fs = require('node:fs');
  const qualifyingSource = fs.readFileSync(require.resolve('../qualifying.html'), 'utf8');
  assert.match(qualifyingSource, /<div class="sc-row \$\{isPlayed\?'done':'wait'\}">/);
  assert.match(qualifyingSource, /class="sc-team \$\{aWin\?'win':''\}"/);
  assert.match(qualifyingSource, /class="sc-score">\$\{isPlayed/);
  const live = '<div class="cell" data-n="1"><div class="vs"><span class="u">甲隊</span><span class="u">乙隊</span></div><span class="sc">21 : 12</span></div>';
  // 這份 fixture 直接依 qualifying.html 的 scheduleCard() 真實 rendered markup 組成。
  const qual = '<div class="ccard" data-gid="A"><div class="sc-row done"><span class="sc-court">場1</span><span class="sc-team win" style="color:#fff">甲隊</span><span class="sc-score"><b class="w">21</b><i>:</i><b>12</b></span><span class="sc-team r">乙隊</span><span class="sc-flag">✓</span></div></div>';
  const mobile = '<article class="card live-card"><div class="live-top"><b>● 場地 01</b><span>#1・Q1・資格</span></div><div class="score-line winner"><span>甲隊</span><strong>21</strong></div><div class="score-line"><span>乙隊</span><strong>12</strong></div></article>';
  const observer = new DualSiteObserver({
    chromeRunner: async (url) => url.includes('qualifying') ? qual : (url.includes('solar-cup-two-live') ? mobile : live),
    sleepFn: async () => {}, now: () => 1
  });
  assert.equal(observer.verify(SITES.find((site) => site.name === 'main-qualifying'), qual, { matchId: 'qual-1', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 }), true);
  const result = await observer.afterWrite({ matchId: 'qual-1', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 });
  assert.deepEqual(result.sites, ['main-live', 'mobile-battle']);
  const findings = await observer.flush();
  assert.ok(findings.some((finding) => finding.code === 'OBSERVER_EVENT_VISIBLE'));
  assert.ok(!findings.some((finding) => finding.code === 'DISPLAY_SYNC_TIMEOUT'));
  const mobileEvidence = observer.evidence.find((evidence) => evidence.sample === 'event' && evidence.site === 'mobile-battle');
  const mainEvidence = observer.evidence.find((evidence) => evidence.sample === 'event' && evidence.site === 'main-live');
  assert.equal(mobileEvidence.url, '/solar-cup-two-live/?view=live&filter=recent');
  assert.equal(mainEvidence.url, '/solarcup-info/solar-cup-live.html');
  const incomplete = new DualSiteObserver({ chromeRunner: async () => live, now: () => 1 });
  await incomplete.afterWrite({ matchId: 'qual-1', scoreA: 21, scoreB: 12 });
  assert.ok((await incomplete.flush()).some((finding) => finding.code === 'OBSERVER_EXPECTED_TEAMS_MISSING'));
  const down = new DualSiteObserver({ chromeRunner: async () => { throw new Error('down'); } });
  await assert.rejects(() => down.sweep(), (error) => error.p0 === true);
});

test('observer 首輪 miss、次輪同步成功：保留兩輪 evidence，但不產假 timeout／bug finding', async () => {
  const live = '<div class="cell" data-n="1"><div class="vs"><span class="u">甲隊</span><span class="u">乙隊</span></div><span class="sc">21 : 12</span></div>';
  const mobile = '<article class="card live-card"><div class="live-top"><b>● 場地 01</b><span>#1・Q1・資格</span></div><div class="score-line winner"><span>甲隊</span><strong>21</strong></div><div class="score-line"><span>乙隊</span><strong>12</strong></div></article>';
  let clock = 1; let calls = 0;
  const observer = new DualSiteObserver({
    chromeRunner: async (url) => { calls += 1; if (calls <= 2) return '<main>同步中</main>'; return url.includes('solar-cup-two-live') ? mobile : live; },
    now: () => clock, sleepFn: async (ms) => { clock += ms; }
  });
  await observer.afterWrite({ matchId: 'qual-1', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 });
  const findings = await observer.flush();
  const manifest = {
    run_id: 'observer-retry', state: 'COMPLETE', pre_canonical_hash: 'same', post_image: {},
    checkpoint: { completed: ['qual-1'] }, plan: [{ id: 'qual-1', scenario: 'A' }],
    observer_evidence: observer.evidence, observer_findings: findings,
    restore_evidence: { final_canonical_hash: 'same' }
  };
  const report = reportPayload({ manifest, findings: [], observerFindings: findings });
  const eventEvidence = observer.evidence.filter((item) => item.eventId === 'qual-1');
  assert.ok(eventEvidence.some((item) => item.seen === false));
  assert.ok(eventEvidence.some((item) => item.seen === true));
  assert.ok(report.findings.some((item) => item.code === 'OBSERVER_EVENT_VISIBLE'));
  assert.ok(!report.findings.some((item) => item.code === 'DISPLAY_EVENT_NOT_VISIBLE' || item.code === 'DISPLAY_SYNC_TIMEOUT'));
  assert.equal(report.bugs, 0);
});

test('淘汰樹 observer：使用 bracket-tree.html 真實 gno／seed／s 結構同卡驗證；每場 probe 改走 main live＋mobile recent', async () => {
  const fs = require('node:fs'); const bracketSource = fs.readFileSync(require.resolve('../bracket-tree.html'), 'utf8');
  assert.match(bracketSource, /<div class="r1card"><div class="gno">#\$\{m\.no\}/);
  assert.match(bracketSource, /<div class="seed \$\{win\?'win':''\}"/);
  assert.match(bracketSource, /<span class="s">\$\{sc\}<\/span>/);
  const live = '<div class="cell" data-n="108"><div class="vs"><span class="u">甲隊</span><span class="u">乙隊</span></div><span class="sc">21 : 12</span></div>';
  // 依 bracket-tree.html 的 seed() 與 stageHTML() 實際輸出，不使用舊版 .u/.sc selector。
  const bracket = '<div class="r1card"><div class="gno">#108<span class="seat">▸ A1</span></div><div class="seed win" data-tid="a"><span>甲隊</span><span class="s">21</span></div><div class="seed" data-tid="b"><span>乙隊</span><span class="s">12</span></div></div>';
  const mobile = '<article class="card live-card"><div class="live-top"><b>● 場地 01</b><span>#108・KO108・淘汰</span></div><div class="score-line winner"><span>甲隊</span><strong>21</strong></div><div class="score-line"><span>乙隊</span><strong>12</strong></div></article>';
  const observer = new DualSiteObserver({ chromeRunner: async (url) => url.includes('bracket-tree') ? bracket : (url.includes('solar-cup-two-live') ? mobile : live), now: () => 1 });
  assert.equal(observer.verify(SITES.find((site) => site.name === 'main-bracket'), bracket, { matchId: 'knockout-108', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 }), true);
  const result = await observer.afterWrite({ matchId: 'knockout-108', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 });
  assert.deepEqual(result, { eventId: 'knockout-108', seen: true, latencyMs: 0, timeout: false, sites: ['main-live', 'mobile-battle'] });
});

test('mobile observer：使用 solar-cup-two-live 真實 live-card／score-line 契約，錯隊錯分錯場均拒絕', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync('/Users/dean/Desktop/solar-cup-two-live/index.html', 'utf8');
  assert.match(source, /<article class="card live-card">/);
  assert.match(source, /<div class="live-top"><b>\$\{tierDotCol/);
  assert.match(source, /<div class="score-line \$\{score && score\.sa > score\.sb \? 'winner' : ''\}"><span>\$\{esc\(a\)\}<\/span><strong>\$\{score\?\.sa \?\? '—'\}<\/strong><\/div>/);
  // 此 fixture 逐字沿用 index.html renderLive() 的 live-card／score-line 結構。
  const mobile = '<article class="card live-card"><div class="live-top"><b><span style="color:#fff">●</span> 場地 03</b><span>#42・Q42・資格</span></div><div class="score-line winner"><span>甲隊</span><strong>21</strong></div><div class="score-line"><span>乙隊</span><strong>12</strong></div><div class="live-foot"><span class="live-dot">已完賽</span><span>資格・A</span></div></article>';
  const expected = { matchId: 'qual-42', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 };
  const observer = new DualSiteObserver({ chromeRunner: async () => mobile });
  const mobileSite = SITES.find((site) => site.name === 'mobile-battle');
  assert.equal(observer.verify(mobileSite, mobile, expected), true);
  assert.equal(observer.verify(mobileSite, mobile, { ...expected, teamB: '丙隊' }), false);
  assert.equal(observer.verify(mobileSite, mobile, { ...expected, scoreB: 11 }), false);
  assert.equal(observer.verify(mobileSite, mobile, { ...expected, matchId: 'qual-43' }), false);
});

test('observer Chrome reject：背景 cleanup 不產生 unhandledRejection', async () => {
  const observer = new DualSiteObserver({ chromeRunner: async () => { throw new Error('chrome down'); }, now: () => 1 });
  let unhandled = null; const onUnhandled = (reason) => { unhandled = reason; };
  process.once('unhandledRejection', onUnhandled);
  await assert.rejects(() => observer.afterWrite({ matchId: 'qual-1', teamA: '甲隊', teamB: '乙隊', scoreA: 21, scoreB: 12 }), (error) => error.p0 === true);
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null);
  assert.equal(observer.pending.size, 0);
});

test('pending evidence 必須真的讀到並列待判定；報告只採 assertion／讀回 hash 證據', async () => {
  const observer = new DualSiteObserver({ chromeRunner: async () => '<div>並列待判定</div>', now: () => 1 });
  const pending = await observer.pendingEvidence('qual-25');
  assert.equal(pending.pendingObserved, true); assert.deepEqual(pending.sites.map((site) => site.site), ['main-qualifying', 'mobile-advance']);
  let pendingClock = 1;
  const onlyOne = new DualSiteObserver({ chromeRunner: async (url) => url.includes('qualifying') ? '<div>並列待判定</div>' : '<div>尚未判定</div>', now: () => pendingClock, sleepFn: async (ms) => { pendingClock += ms; } });
  const notReady = await onlyOne.pendingEvidence('qual-25');
  assert.equal(notReady.pendingObserved, false); assert.deepEqual(notReady.sites.map((site) => site.seen), [true, false]);
  const manifest = {
    run_id: 'report-test', state: 'COMPLETE', pre_canonical_hash: 'abc', post_image: {}, checkpoint: { completed: ['qual-1'] },
    plan: [{ id: 'qual-1', scenario: 'A', steps: [{ assertion: 'pace' }] }, { id: 'qual-2', scenario: 'B', steps: [{ assertion: 'same_wins' }] }],
    assertion_evidence: [{ eventId: 'qual-1', status: 'pass' }], restore_evidence: { final_canonical_hash: 'abc' }
  };
  const report = reportPayload({ manifest, observerFindings: [{ code: 'OBSERVER_EVENT_VISIBLE', eventId: 'qual-1', latencyMs: 321, severity: 'info' }] });
  assert.equal(report.scenarios.A.pass, 1); assert.equal(report.scenarios.B.skipped, 1);
  assert.equal(report.restore.verified, true); assert.equal(report.syncLatencyMs.p50, 321);
});

class FixtureValuesAdapter extends MockAdapter {
  constructor(ranges = {}) { super(); this.ranges = ranges; }
  async values(range) { return this.ranges[range] || []; }
}

test('runner B/C 真斷言：讀回 D:J；C3 看不到並列時記 non-P0 並照既定決策繼續', async () => {
  const standings = [
    ['競資-A', 2, 61, 31, 30, 61 / 31, 1], ['競資-A', 2, 62, 50, 12, 62 / 50, 2],
    ['競資-A', 2, 52, 61, -9, 52 / 61, 3], ['競資-A', 0, 30, 63, -33, 30 / 63, 4],
    ['競資-B', 2, 53, 32, 21, 53 / 32, '並列待判定'], ['競資-B', 2, 53, 32, 21, 53 / 32, '並列待判定'],
    ['競資-B', 2, 53, 32, 21, 53 / 32, '並列待判定'], ['競資-B', 0, 0, 63, -63, 0, 4]
  ];
  const plan = buildScenarioPlan('bc-runner');
  const adapter = new FixtureValuesAdapter({ '3_資格賽積分榜!D2:J101': standings });
  const observer = { async afterWrite() {}, async pendingEvidence() { return { pendingObserved: false }; }, async flush() { return []; } };
  const { runner } = fakeClockRunner(plan, adapter); runner.observer = observer;
  const manifest = await runner.snapshot('bc-runner');
  await runner.executeMatch(manifest, plan.find((match) => match.no === 46));
  assert.equal(manifest.assertion_evidence['qual-46'].status, 'pass');
  await runner.executeMatch(manifest, plan.find((match) => match.no === 47));
  assert.equal(manifest.assertion_evidence['qual-47'].status, 'fail');
  assert.ok(manifest.findings.some((finding) => finding.code === 'C3_PENDING_ASSERT_FAILED'));
  assert.equal(manifest.state, 'RUNNING');
  assert.equal(manifest.approvals.APPROVE_C2_DECISION.outcome, 'PREDECLARED_DETERMINISTIC_CONTINUE');
});

test('runner C5：十場形成五隊 2 勝、64:64、PENDING_DECISION 且不套 H2H', async () => {
  const c5Sheet = Array.from({ length: 4 }, () => []);
  for (let index = 0; index < 5; index += 1) c5Sheet.push(['', '', '', 2, 64, 64, 1, '（並列）', '⚠ 並列待判定']);
  const adapter = new FixtureValuesAdapter({ '4b_複賽晉級!A1:I9': c5Sheet });
  const plan = buildScenarioPlan('c5-runner'); const { runner } = fakeClockRunner(plan, adapter);
  runner.observer = { evidence: [], async dom() { return '<div>⚠ 並列待判定</div>'; }, emit(item) { this.evidence.push(item); } };
  const manifest = await runner.snapshot('c5-runner');
  const teams = ['甲', '乙', '丙', '丁', '戊']; const pairs = loadTopology().RR_PAIRS;
  C5_NOS.forEach((no, index) => {
    const match = plan.find((candidate) => candidate.no === no); const [a, b] = pairs[index];
    manifest.runtime_evidence.match_teams[match.id] = [teams[a], teams[b]];
  });
  await runner.validateC5(manifest, plan.find((match) => match.no === 278));
  assert.ok(C5_NOS.every((no) => manifest.assertion_evidence[plan.find((match) => match.no === no).id]?.status === 'pass'));
  assert.equal(manifest.runtime_evidence.pending_decisions['C5-plat-rrA'].policy, 'PENDING_DECISION_NO_H2H');
  assert.equal(manifest.runtime_evidence.pending_decisions['C5-plat-rrA'].sites.length, 2);
});

test('runner K：只讀 6/7 表，驗 SUMIFS 與 C/D/E 兩層同分規則', async () => {
  const expected = {
    different: { clubs: ['P', 'Q'], total: 100, comps: [60, 40] },
    joint: { clubs: ['R', 'S'], total: 80, comp: 30 }
  };
  const teamRows = [
    [1, 'P競', '競技組', 'P', '', '', '', '', '', '', '', '', 60], [2, 'P休', '休閒組', 'P', '', '', '', '', '', '', '', '', 40],
    [3, 'Q競', '競技組', 'Q', '', '', '', '', '', '', '', '', 40], [4, 'Q休', '休閒組', 'Q', '', '', '', '', '', '', '', '', 60],
    [5, 'R競', '競技組', 'R', '', '', '', '', '', '', '', '', 30], [6, 'R休', '休閒組', 'R', '', '', '', '', '', '', '', '', 50],
    [7, 'S競', '競技組', 'S', '', '', '', '', '', '', '', '', 30], [8, 'S休', '休閒組', 'S', '', '', '', '', '', '', '', '', 50]
  ];
  while (teamRows.length < 108) teamRows.push([teamRows.length + 1, `自由${teamRows.length}`, '休閒組', '自由組', '', '', '', '', '', '', '', '', 0]);
  const clubRows = [
    ['P', 2, 100, 60, 1, ''], ['Q', 2, 100, 40, 2, ''], ['R', 2, 80, 30, 3, ''], ['S', 2, 80, 30, 3, ''],
    ['自由組', 100, 0, 0, 9, ''], ['甲團', 0, 0, 0, 9, ''], ['乙團', 0, 0, 0, 9, ''], ['丙團', 0, 0, 0, 9, ''], ['丁團', 0, 0, 0, 9, '']
  ];
  const adapter = new FixtureValuesAdapter({ '6_積分總表!A2:M109': teamRows, '7_球團積分!A2:F11': clubRows });
  const plan = buildScenarioPlan('k-validator'); const match = plan.find((candidate) => candidate.no === 310);
  match.kFixture = { flipNos: [305], expected, minimalFlips: 1, candidateCount: 24 };
  const { runner } = fakeClockRunner(plan, adapter); const manifest = await runner.snapshot('k-validator');
  await runner.validateK(manifest, match);
  const evidence = manifest.assertion_evidence[match.id].assertions.at(-1);
  assert.equal(evidence.status, 'pass'); assert.equal(evidence.formulasWritten, false); assert.equal(evidence.sumifsPassed, 9);
});

test('segment observer state：findings/evidence/latency 跨 runner hydrate 累積且不重覆', async () => {
  const plan = buildScenarioPlan('observer-segments');
  const firstObserver = {
    evidence: [{ eventId: 'seg-1', site: 'primary', latencyMs: 12 }],
    async flush() { return [{ code: 'OBSERVER_EVENT_VISIBLE', severity: 'info', eventId: 'seg-1', latencyMs: 12 }]; }
  };
  const { runner: first } = fakeClockRunner(plan); first.observer = firstObserver;
  const manifest = await first.snapshot('observer-segments');
  await first.captureObserverState(manifest);
  await first.captureObserverState(manifest);
  const secondObserver = {
    evidence: [{ eventId: 'seg-2', site: 'mobile', latencyMs: 34 }],
    async flush() { return [{ code: 'OBSERVER_EVENT_VISIBLE', severity: 'info', eventId: 'seg-2', latencyMs: 34 }]; }
  };
  const { runner: second } = fakeClockRunner(plan); second.observer = secondObserver;
  await second.captureObserverState(manifest);
  assert.deepEqual(manifest.observer_findings.map((item) => item.eventId), ['seg-1', 'seg-2']);
  assert.deepEqual(manifest.observer_evidence.map((item) => item.latencyMs), [12, 34]);
  const report = reportPayload({ manifest, observerFindings: manifest.observer_findings });
  assert.equal(report.syncLatencyMs.samples, 2); assert.equal(report.syncLatencyMs.max, 34);
});

test('autonomous：baseline → 三表 canary restore → clear → 310 場 → CAS restore/report', async () => {
  const dir = require('node:fs').mkdtempSync('/private/tmp/autonomous-sim-');
  const adapter = new MockAdapter({ '2_資格賽成績!K2': { userEnteredValue: { numberValue: 9 } } }, {
    armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'x', 3: 'x', 6: 'x', 7: 'x' } },
    authoritativeRows: { qualification: Array.from({ length: 150 }, (_, i) => i + 1), knockout: Array.from({ length: 132 }, (_, i) => i + 1), invitational: Array.from({ length: 28 }, (_, i) => i + 1) }
  });
  const readinessCalls = [];
  const observer = {
    evidence: [],
    async sweep() {
      readinessCalls.push('sweep');
      const evidence = [
        { site: 'main-live', url: '/solarcup-info/solar-cup-live.html', rendered: true, seen: true, sample: 'sweep', bytes: 100, latencyMs: 1 },
        { site: 'mobile-battle', url: '/solar-cup-two-live/', rendered: true, seen: true, sample: 'sweep', bytes: 100, latencyMs: 1 }
      ];
      this.evidence.push(...evidence);
      return evidence;
    },
    async afterWrite(event) {
      this.evidence.push({ eventId: event?.matchId || null, stage: event?.stage || null, latencyMs: 1 });
    },
    async pendingEvidence(id) { return { eventId: id }; }, async flush() { return []; }
  };
  const lease = { persistent: true, async acquire() { return { fencingToken: 'test-fence' }; }, async assertHeld() {}, async release() {} };
  const plan = buildScenarioPlan('k-search-explore');
  const canaryKnockout = plan.find((match) => match.stage === 'knockout');
  canaryKnockout.teamA = 'Canary 淘汰 A'; canaryKnockout.teamB = 'Canary 淘汰 B';
  let clock = 0;
  const runner = new SimulationRunner({ adapter, observer, stateDir: dir, mode: 'run', armed: true, autonomous: true, spreadsheetId: EXPECTED_SPREADSHEET_ID, lease, resolver: new ScriptedResolver(), plan, allowedStages: ['qualification', 'knockout', 'invitational'], now: () => clock, sleepFn: async (ms) => { clock += ms; } });
  const result = await runner.start('autonomous-run');
  assert.equal(result.state, 'COMPLETE');
  assert.deepEqual((await adapter.readCells(['2_資格賽成績!K2']))['2_資格賽成績!K2'], { userEnteredValue: { numberValue: 9 } });
  assert.equal(result.reason, 'NORMAL_RESTORED');
  assert.equal(result.restore_evidence.verified, true);
  assert.equal(result.restore_evidence.final_canonical_hash, result.pre_canonical_hash);
  assert.deepEqual(readinessCalls, ['sweep']);
  assert.equal(result.runtime_evidence.canary_observer_readiness.length, 2);
  assert.ok(result.runtime_evidence.canary_observer_readiness.every((item) => item.rendered === true && item.sample === 'canary-readiness'));
  assert.ok(!(result.observer_findings || []).some((item) => item.code === 'DISPLAY_SYNC_TIMEOUT'));
  for (const scenario of ['A', 'H', 'I', 'J']) {
    const matches = result.plan.filter((match) => match.scenario === scenario);
    assert.ok(matches.length > 0);
    assert.ok(matches.every((match) => result.assertion_evidence[match.id]?.status === 'pass'), `scenario ${scenario} evidence`);
  }
});
