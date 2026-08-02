'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SimulationRunner, EXPECTED_SPREADSHEET_ID, cellForNumber, parseArgs } = require('./runner');
const { MockAdapter } = require('./mock-adapter');
const { SheetsRestAdapter, SPREADSHEET_ID } = require('./sheets-rest-adapter');
const { STATES, assertLegalScore, pairedJitter, sameCells, scoreFor, writeJson } = require('./lib');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'solarcup-sim-')); }
function plan(n = 3, stage = 'qualification') {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, stage, cells: [`S!A${i + 1}`, `S!B${i + 1}`] }));
}
function markObserver(dir) { fs.writeFileSync(path.join(dir, 'OBSERVER_READY'), 'approved\n'); }
function approve(dir) { fs.writeFileSync(path.join(dir, 'CANARY_APPROVED'), 'approved\n'); }
function runner(adapter, dir, extra = {}) {
  return new SimulationRunner({ adapter, stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, plan: plan(), fast: true, mode: 'dry-run', ...extra });
}
async function canaryThenComplete(instance, dir, id) {
  markObserver(dir);
  const waiting = await instance.start(id);
  assert.equal(waiting.state, STATES.CANARY_WAITING_APPROVAL);
  approve(dir);
  return instance.start(id);
}

test('normal：canary 等待明確核准後完成 exact restore', async () => {
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } }); const dir = temp();
  const result = await canaryThenComplete(runner(adapter, dir), dir, 'normal');
  assert.equal(result.state, STATES.COMPLETE);
  assert.deepEqual(
    await adapter.readCells(plan().flatMap((m) => m.cells)),
    Object.fromEntries(plan().flatMap((m) => m.cells.map((c) => [c, null])))
  );
});

test('canary：缺 observer 或 approval 時 fail-closed', async () => {
  const dir = temp(); const r = runner(new MockAdapter(), dir);
  await assert.rejects(() => r.start('missing-observer'), /OBSERVER_READY/);
  markObserver(dir);
  const waiting = await r.start('waiting');
  assert.equal(waiting.state, STATES.CANARY_WAITING_APPROVAL);
  const stillWaiting = await r.start('waiting');
  assert.equal(stillWaiting.state, STATES.CANARY_WAITING_APPROVAL);
});

test('manual stop：已寫入部分會復原', async () => {
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } }); const dir = temp();
  const result = await canaryThenComplete(runner(adapter, dir, { stopAfter: 1 }), dir, 'manual');
  assert.equal(result.reason, 'MANUAL_STOP_RESTORED');
  assert.equal(result.state, STATES.COMPLETE);
});

test('P0 abort：第二場被外部改動時，第一場仍會復原', async () => {
  class P0Adapter extends MockAdapter {
    async writeCells(values) { await super.writeCells(values); if (this.writeCount === 1) this.mutate('S!A2', cellForNumber(9)); }
  }
  const adapter = new P0Adapter(); const dir = temp(); markObserver(dir);
  const result = await runner(adapter, dir).start('p0');
  assert.equal(result.state, STATES.RESTORE_FAILURE);
  assert.match(result.reason, /^P0_ABORT:/);
  assert.deepEqual((await adapter.readCells(['S!A1']))['S!A1'], null);
});

test('API timeout：寫入已接受但 timeout，readback 後不重覆提交', async () => {
  const adapter = new MockAdapter({}, { timeoutAfterWriteOnce: true }); const dir = temp();
  const result = await canaryThenComplete(runner(adapter, dir), dir, 'timeout');
  assert.equal(result.state, STATES.COMPLETE);
  assert.ok(adapter.writeCount >= 1);
});

test('restore conflict：協作者修改不會被覆蓋', async () => {
  const adapter = new MockAdapter(); const dir = temp(); const r = runner(adapter, dir);
  const manifest = await r.snapshot('conflict'); const match = manifest.plan[0];
  const post = { [match.cells[0]]: cellForNumber(21), [match.cells[1]]: cellForNumber(4) };
  await adapter.writeCells(post); Object.assign(manifest.post_image, post); r.save(manifest);
  adapter.mutate(match.cells[0], cellForNumber(9));
  const result = await r.restore(manifest);
  assert.equal(result.state, STATES.MANUAL_HOLD);
  assert.match(result.reason, /RESTORE_CONFLICT/);
});

test('restore-only：先 metadata/precheck，再以持久 lease idempotent 重跑', async () => {
  const lease = { persistent: true, async acquire() { return { fencingToken: 'fence-1' }; }, async assertHeld() {}, async release() {} };
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } }); const dir = temp();
  const r = runner(adapter, dir, { mode: 'restore-only', armed: true, fast: false, lease });
  const manifest = await r.snapshot('restore-only'); const match = manifest.plan[0];
  const post = { [match.cells[0]]: cellForNumber(21), [match.cells[1]]: cellForNumber(4) };
  await adapter.writeCells(post); Object.assign(manifest.post_image, post); r.save(manifest);
  assert.equal((await r.restoreOnly('restore-only')).state, STATES.COMPLETE);
  assert.equal((await r.restoreOnly('restore-only')).state, STATES.COMPLETE);
});

test('pending stage gate：未獲得允許不可進入下一 stage', async () => {
  const dir = temp(); const gated = runner(new MockAdapter(), dir, { plan: [...plan(3), { id: 'knockout-1', stage: 'knockout', cells: ['S!A9', 'S!B9'] }] });
  const result = await canaryThenComplete(gated, dir, 'gate');
  assert.equal(result.state, STATES.COMPLETE);
  assert.match(result.reason, /PENDING_STAGE_GATE:knockout/);
});

test('正式 adapter：解析 Google API cell response 並只以 userEnteredValue 比較', async () => {
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test' });
  const metadata = { properties: { timeZone: 'Asia/Taipei' }, sheets: [
    { properties: { title: '2_資格賽成績', sheetId: 252930776 } }, { properties: { title: '4_淘汰賽成績', sheetId: 1125219206 } }, { properties: { title: '5_曜請成績', sheetId: 848445550 } }
  ] };
  let body;
  adapter.request = async (_url, options = {}) => {
    if (!options.method) return adapter.sheetIds && Object.keys(adapter.sheetIds).length ? { sheets: [{ data: [{ rowData: [{ values: [{ userEnteredValue: { numberValue: 21 }, effectiveValue: { numberValue: 21 }, formattedValue: '21' }] }] }, { rowData: [{ values: [{ userEnteredValue: { numberValue: 4 }, effectiveValue: { numberValue: 4 }, formattedValue: '4' }] }] }] }] } : metadata;
    body = JSON.parse(options.body); return {};
  };
  await adapter.precheck();
  const cells = await adapter.readCells(['2_資格賽成績!K2', '2_資格賽成績!L2']);
  assert.equal(cells['2_資格賽成績!K2'].userEnteredValue.numberValue, 21);
  assert.ok(sameCells(cells, { '2_資格賽成績!K2': cellForNumber(21), '2_資格賽成績!L2': cellForNumber(4) }));
  await adapter.writeCells({ '2_資格賽成績!K2': cellForNumber(21) });
  assert.equal(body.requests[0].updateCells.range.sheetId, 252930776);
  assert.equal(body.requests[0].updateCells.range.startColumnIndex, 10);
});

test('adapter allowlist、armed-fast 與無持久 lease 均拒絕', async () => {
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test' });
  assert.throws(() => adapter.assertAllowedRef('2_資格賽成績!A2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!J2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!L2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!M134'), /allowlist/);
  assert.throws(() => parseArgs(['run', '--armed', '--fast']), /不可同時/);
  const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true });
  assert.throws(() => r.assertArmed(), /持久化 external lease/);
});

test('armed precheck：projection 3/6/7/8 與 LIVE B12 證據缺失即拒絕', async () => {
  const lease = { persistent: true, async acquire() { return { fencingToken: 'fence-1' }; }, async assertHeld() {}, async release() {} };
  const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease });
  await assert.rejects(() => r.precheck(), /projection\/LIVE/);
});

test('LIVE gate 明確只讀 B12，B11 總場次與 B13 最後更新不會成為 gate', async () => {
  let received;
  const adapter = new MockAdapter({}, { armedGateResult: (requirements) => { received = requirements; return { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } }; } });
  const lease = { persistent: true, async acquire() { return { fencingToken: 'fence-1' }; }, async assertHeld() {}, async release() {} };
  const r = new SimulationRunner({ adapter, stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease });
  await r.precheck();
  assert.equal(received.liveCell, '0_賽事設定!B12');
  assert.notEqual(received.liveCell, '0_賽事設定!B11');
  assert.notEqual(received.liveCell, '0_賽事設定!B13');
});

test('正式 resume：持有新 lease 等待帶新 fencing token 的 run-scoped marker', async () => {
  const dir = temp();
  const lease = { persistent: true, async acquire() { return { fencingToken: 'new-fence' }; }, async assertHeld() {}, async release() {} };
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } });
  let r;
  const sleepFn = async () => {
    const manifest = require('./lib').readJson(r.manifestPath('sim-resume'));
    const marker = { run_id: 'sim-resume', fencing_token: 'new-fence', manifest_hash: r.manifestHash(manifest), expires_at: new Date(Date.now() + 60_000).toISOString() };
    writeJson(r.markerPath('sim-resume', 'canary-observed'), marker);
    writeJson(r.markerPath('sim-resume', 'canary-approved'), marker);
  };
  r = new SimulationRunner({ adapter, stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease, plan: [], sleepFn, markerWaitMs: 1_000 });
  const manifest = await r.snapshot('sim-resume'); manifest.state = STATES.CANARY_WAITING_APPROVAL; r.save(manifest);
  const result = await r.start('sim-resume');
  assert.equal(result.state, STATES.COMPLETE);
});

test('Sheets request timeout 轉為 ETIMEDOUT', async () => {
  const original = global.fetch;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test', requestTimeoutMs: 1 });
  await assert.rejects(() => adapter.request('https://example.invalid'), (error) => error.code === 'ETIMEDOUT');
  global.fetch = original;
});

test('比分與配對 jitter 規格', () => {
  [[21, 0], [19, 21], [21, 19]].forEach(assertLegalScore);
  assert.throws(() => assertLegalScore([20, 20]));
  const values = pairedJitter(150, () => 0.25);
  assert.equal(values.reduce((a, b) => a + b, 0), 4500);
  for (let i = 0; i < values.length; i += 2) assert.equal(values[i] + values[i + 1], 60);
  for (let seed = 0; seed < 2_000; seed += 1) {
    const score = scoreFor(`sim-property-${seed}`, `match-${seed}`);
    assert.notEqual(score[0], score[1]);
    assertLegalScore(score);
  }
});
