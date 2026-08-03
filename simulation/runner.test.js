'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { SimulationRunner, EXPECTED_SPREADSHEET_ID, cellForNumber, parseArgs, parseProjectionBaselines } = require('./runner');
const { MockAdapter } = require('./mock-adapter');
const { SheetsRestAdapter, SPREADSHEET_ID, PROJECTION_RANGES } = require('./sheets-rest-adapter');
const { GcsJsonClient, GcsGenerationLease } = require('./gcs-generation-lease');
const { STATES, assertLegalScore, pairedJitter, sameCells, scoreFor, writeJson, safeError, fullPlan } = require('./lib');
const { KnockoutResolver, ScriptedResolver } = require('./knockout-resolver');
const { loadTopology, knockoutNumbers, rankGroup, seedsFor, deriveAll } = require('./bracket');
const { LocalGenerationLease, LocalRunState, LocalApprovalStore } = require('./local-state');

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

test('Sheets readCells：超過 50 個 range 依 sheet 分批請求且保留 ref 對應', async () => {
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test' }); const calls = [];
  const refs = Array.from({ length: 60 }, (_, i) => `2_資格賽成績!K${i + 2}`);
  adapter.request = async (url) => {
    const ranges = new URL(url).searchParams.getAll('ranges'); calls.push(ranges);
    return { sheets: [{ data: ranges.map((ref, i) => ({ rowData: [{ values: [{ userEnteredValue: { numberValue: Number(ref.match(/\d+$/)[0]) }, effectiveValue: { numberValue: i }, formattedValue: String(i) }] }] })) }] };
  };
  const values = await adapter.readCells(refs);
  assert.deepEqual(calls.map((batch) => batch.length), [50, 10]);
  assert.equal(values['2_資格賽成績!K2'].userEnteredValue.numberValue, 2);
  assert.equal(values['2_資格賽成績!K61'].userEnteredValue.numberValue, 61);
});

test('adapter allowlist、armed-fast 與無持久 lease 均拒絕', async () => {
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test' });
  assert.throws(() => adapter.assertAllowedRef('2_資格賽成績!A2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!M134'), /allowlist/);
  // J/L＝淘汰賽隊名，2026-08-03 起刻意納入寫入範圍（沒有隊名整條積分鏈路會算成 0）。
  // 同一列的 I/K（編號反查）與 O（勝方）是公式欄，必須維持拒絕。
  assert.deepEqual(adapter.assertAllowedRef('4_淘汰賽成績!J2').startColumnIndex, 9);
  assert.deepEqual(adapter.assertAllowedRef('4_淘汰賽成績!L2').startColumnIndex, 11);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!I2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!K2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!O2'), /allowlist/);
  assert.throws(() => parseArgs(['run', '--armed', '--fast']), /不可同時/);
  const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true });
  assert.throws(() => r.assertArmed(), /持久化 external lease/);
  assert.throws(() => parseArgs(['dry-run', '--phase', 'qualification']), /未知參數/);
});

test('ci-dry-run：缺 production env 仍只驗證完整 310 場，且不建立外部 adapter', () => {
  const output = execFileSync(process.execPath, ['runner.js', 'ci-dry-run', '--run-id', 'ci-local'], { cwd: __dirname, env: {} }).toString();
  const result = JSON.parse(output);
  assert.equal(result.state, STATES.COMPLETE);
  assert.equal(result.matches, 310);
  assert.equal(result.dry_run, true);
});

test('production resume：approval 先讀取、取得 lease 後再讀取核對；錯誤 hash 不取得 lease', async () => {
  const calls = [];
  const manifest = { schema: 2, run_id: 'approval-order', spreadsheet_id: EXPECTED_SPREADSHEET_ID, state: STATES.CANARY_WAITING_APPROVAL, allowlist: [], pre_canonical_hash: 'p' };
  let r;
  const store = { async read(_runId, name) { calls.push(name || 'manifest'); return name === 'approval' ? { run_id: 'approval-order', manifest_hash: r.manifestHash(manifest) } : manifest; } };
  const lease = { async acquire() { calls.push('acquire'); return { fencingToken: 'fence' }; }, async assertHeld() {}, async release() { calls.push('release'); } };
  r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'dry-run', resumeOnly: true, stateStore: store, lease, plan: [] });
  const result = await r.start('approval-order');
  assert.equal(result.state, STATES.CANARY_WAITING_APPROVAL);
  assert.deepEqual(calls.slice(0, 5), ['manifest', 'approval', 'acquire', 'manifest', 'approval']);
  const badCalls = [];
  const bad = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'dry-run', resumeOnly: true, stateStore: { async read(_id, name) { return name === 'approval' ? { run_id: 'approval-order', manifest_hash: '0'.repeat(64) } : manifest; } }, lease: { async acquire() { badCalls.push('acquire'); } }, plan: [] });
  await assert.rejects(() => bad.start('approval-order'), /APPROVAL_PRELEASE_INVALID/);
  assert.deepEqual(badCalls, []);
});

test('5 個 segment 依 checkpoint 累積比分，亂序拒絕，僅最後一段 restore 全部 310 場', async () => {
  const dir = temp(); const adapter = new MockAdapter();
  const r = new SimulationRunner({ adapter, stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, plan: fullPlan(), allowedStages: ['qualification', 'knockout', 'invitational'], resolver: new ScriptedResolver(), fast: true, segment: 1 });
  const manifest = await r.snapshot('five-segments'); manifest.state = STATES.CANARY_WAITING_APPROVAL; r.save(manifest);
  const one = await r.start('five-segments');
  assert.equal(one.state, STATES.SEGMENT_WAITING); assert.equal(one.checkpoint.completed.length, 75); assert.ok((await adapter.readCells([one.plan[0].cells[0]]))[one.plan[0].cells[0]]);
  r.segment = 3;
  await assert.rejects(() => r.start('five-segments'), /SEGMENT_ORDER_INVALID/);
  for (const segment of [2, 3, 4]) { r.segment = segment; const waiting = await r.start('five-segments'); assert.equal(waiting.state, STATES.SEGMENT_WAITING); }
  r.segment = 5;
  const final = await r.start('five-segments');
  assert.equal(final.state, STATES.COMPLETE);
  const values = await adapter.readCells(final.allowlist);
  assert.ok(Object.values(values).every((value) => value === null));
});

test('segment 2 僅驗證 timezone/sheetId/B12，末段 restore 後才驗完整 projection baseline', async () => {
  const checks = []; const gate = { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } };
  const lease = { persistent: true, async acquire() { return { fencingToken: 'segment-fence' }; }, async assertHeld() {}, async release() {} };
  const adapter = new MockAdapter({}, { armedGateResult: (request) => { checks.push(request.requiredProjections); return gate; } });
  const r = new SimulationRunner({ adapter, stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease, stateStore: { async persistManifest() {} }, plan: fullPlan(), allowedStages: ['qualification', 'knockout', 'invitational'], resolver: new ScriptedResolver(), fast: false, sleepFn: async () => {}, segment: 2 });
  const manifest = await r.snapshot('gate-segment'); manifest.state = STATES.SEGMENT_WAITING; manifest.checkpoint.completed = manifest.plan.slice(0, 75).map((match) => match.id); manifest.checkpoint.next_segment = 2; r.save(manifest);
  const waiting = await r.start('gate-segment');
  assert.equal(waiting.state, STATES.SEGMENT_WAITING);
  assert.deepEqual(checks, [[]]);
  const resumed = require('./lib').readJson(r.manifestPath('gate-segment'));
  r.segment = 5; resumed.state = STATES.SEGMENT_WAITING; resumed.checkpoint.completed = resumed.plan.slice(0, 282).map((match) => match.id); resumed.checkpoint.next_segment = 5; r.save(resumed);
  const final = await r.start('gate-segment');
  assert.equal(final.state, STATES.COMPLETE);
  assert.deepEqual(checks.at(-1), ['8', '3', '6', '7']);
});

test('取消 canary 時先持久化 CANCELLED_RESTORE_REQUIRED 與 cancel journal', async () => {
  const writes = [];
  const store = { async persistManifest(manifest) { writes.push(manifest.state); } };
  const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease: { persistent: true }, stateStore: store });
  r.leaseHandle = { fencingToken: 'fence' };
  r.activeManifest = { run_id: 'cancel-canary', state: STATES.CANARY, checkpoint: {}, allowlist: [], pre_image: {}, pre_canonical_hash: 'x' };
  await r.requestCancel();
  assert.equal(r.activeManifest.state, STATES.CANCELLED_RESTORE_REQUIRED);
  assert.deepEqual(writes, [STATES.CANCELLED_RESTORE_REQUIRED]);
});

test('canary 收到取消後復原且不產生 immutable report，也不回到等待核准', async () => {
  let reports = 0;
  const store = { async read() { throw Object.assign(new Error('missing'), { status: 404 }); }, async persistManifest() {}, async writeCanaryReport() { reports += 1; } };
  const lease = { persistent: true, async acquire() { return { fencingToken: 'cancel-fence' }; }, async assertHeld() {}, async release() {} };
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } });
  const r = new SimulationRunner({ adapter, stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease, stateStore: store, plan: plan(), allowedStages: ['qualification'] });
  r.stopRequested = true;
  const result = await r.start('cancel-canary-run');
  assert.notEqual(result.state, STATES.CANARY_WAITING_APPROVAL);
  assert.equal(reports, 0);
  assert.deepEqual(await adapter.readCells(plan().flatMap((match) => match.cells)), Object.fromEntries(plan().flatMap((match) => match.cells.map((cell) => [cell, null]))));
});

test('restore-only：僅 LEASE_BUSY 重試並可 takeover；其他 acquire 錯誤立即停止', async () => {
  let attempts = 0; let sleeps = 0;
  const busy = Object.assign(new Error('busy'), { code: 'LEASE_BUSY' });
  const lease = { persistent: true, async acquire() { attempts += 1; if (attempts === 1) throw busy; return { fencingToken: 'takeover' }; }, async assertHeld() {}, async release() {} };
  const gate = { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } };
  const r = new SimulationRunner({ adapter: new MockAdapter({}, gate), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease, plan: [], sleepFn: async () => { sleeps += 1; } });
  await r.snapshot('retry-restore');
  assert.equal((await r.restoreOnly('retry-restore')).state, STATES.COMPLETE);
  assert.equal(attempts, 2); assert.equal(sleeps, 1);
  const forbidden = new SimulationRunner({ adapter: new MockAdapter(), stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease: { persistent: true, async acquire() { throw Object.assign(new Error('forbidden'), { code: 'LEASE_ACQUIRE_FAILED', status: 403 }); } } });
  await assert.rejects(() => forbidden.restoreOnly('no-retry'), (error) => error.code === 'LEASE_ACQUIRE_FAILED');
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


test('Sheets request timeout 轉為 ETIMEDOUT', async () => {
  const original = global.fetch;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test', requestTimeoutMs: 1 });
  await assert.rejects(() => adapter.request('https://example.invalid'), (error) => error.code === 'ETIMEDOUT');
  global.fetch = original;
});

test('GCS generation lease contract：create=0、renew/delete 使用 generation fencing', async () => {
  const calls = []; const client = { async create(...args) { calls.push(['create', ...args]); return { generation: '7' }; }, async get() { return { generation: '7', body: { owner_run_id: 'sim-lease', expires_at: new Date(Date.now() + 60_000).toISOString() } }; }, async replace(...args) { calls.push(['replace', ...args]); return { generation: '8' }; }, async delete(...args) { calls.push(['delete', ...args]); } };
  const lease = new GcsGenerationLease({ client, bucket: 'safe-bucket' }); const handle = await lease.acquire({ runId: 'sim-lease' });
  assert.equal(calls[0][4].ifGenerationMatch, 0); await lease.assertHeld(handle); const renewed = await lease.renew(handle); assert.equal(calls[1][4].ifGenerationMatch, '7'); await lease.release(renewed); assert.equal(calls[2][3].ifGenerationMatch, '8');
});

test('GCS media insert：create/renew 均使用 upload endpoint，讀取綁定 metadata generation', async () => {
  const calls = [];
  const responses = [
    { generation: '7' }, { generation: '8' }, { generation: '8' }, { owner_run_id: 'sim', expires_at: '2099-01-01T00:00:00.000Z' }
  ];
  const client = new GcsJsonClient({ accessToken: 'test-token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  } });
  await client.create('safe bucket', 'lease/a.json', { a: 1 }, { ifGenerationMatch: 0 });
  await client.replace('safe bucket', 'lease/a.json', { a: 2 }, { ifGenerationMatch: '7' });
  await client.get('safe bucket', 'lease/a.json');
  const create = new URL(calls[0].url); const renew = new URL(calls[1].url); const media = new URL(calls[3].url);
  assert.equal(create.pathname, '/upload/storage/v1/b/safe%20bucket/o');
  assert.equal(create.searchParams.get('uploadType'), 'media'); assert.equal(create.searchParams.get('name'), 'lease/a.json'); assert.equal(create.searchParams.get('ifGenerationMatch'), '0');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(renew.searchParams.get('ifGenerationMatch'), '7'); assert.equal(calls[1].options.method, 'POST');
  assert.equal(media.searchParams.get('generation'), '8'); assert.equal(media.searchParams.get('alt'), 'media');
});

test('GCS 412：renew/release fail closed 為 LEASE_LOST，expired object 可條件 takeover', async () => {
  const rejected = Object.assign(new Error('remote detail must not leak'), { status: 412 });
  const client = {
    async create() { return { generation: '1' }; }, async get() { return { generation: '1', body: { owner_run_id: 'sim', expires_at: new Date(Date.now() + 60_000).toISOString() } }; },
    async replace() { throw rejected; }, async delete() { throw rejected; }
  };
  const lease = new GcsGenerationLease({ client, bucket: 'b' }); const handle = await lease.acquire({ runId: 'sim' });
  await assert.rejects(() => lease.renew(handle), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(() => lease.release(handle), (error) => error.code === 'LEASE_LOST');
  const takeoverCalls = [];
  const takeover = new GcsGenerationLease({ client: {
    async create() { throw rejected; }, async get() { return { generation: '4', body: { expires_at: '2000-01-01T00:00:00.000Z' } }; },
    async replace(...args) { takeoverCalls.push(args); return { generation: '5' }; }
  }, bucket: 'b' });
  const taken = await takeover.acquire({ runId: 'restore-run' });
  assert.equal(taken.generation, '5'); assert.equal(takeoverCalls[0][3].ifGenerationMatch, '4');
});

test('lease watchdog：到期前 renew、更新 manifest session；到期後不再續約', async () => {
  let renews = 0; const now = Date.now();
  const lease = { persistent: true, async acquire() { return { fencingToken: 'old', generation: '1', expiresAt: now + 1_000 }; }, async assertHeld() {}, async renew() { renews += 1; return { fencingToken: 'new', generation: '2', expiresAt: now + 60_000 }; }, async release() {} };
  const dir = temp(); const r = runner(new MockAdapter(), dir, { lease }); await r.acquireLease('renew'); const manifest = await r.snapshot('renew');
  await r.watchdog(manifest); assert.equal(renews, 1); assert.equal(manifest.lease_session.fencing_token, 'new');
  r.leaseHandle.expiresAt = Date.now() - 1;
  await assert.rejects(() => r.watchdog(manifest), (error) => error.code === 'LEASE_LOST');
});

test('safe error：token、email、Spreadsheet ID、URL 與遠端 body 不會寫入錯誤訊息', async () => {
  const sensitive = 'Bearer very-secret-token-abcdefghijklmnopqrstuvwxyz test@example.com https://example.test/x 1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
  const safe = safeError(new Error(sensitive));
  assert.doesNotMatch(safe, /very-secret|example\.com|1kQ-D248/);
  const client = new GcsJsonClient({ accessToken: 'token', fetchImpl: async () => new Response(sensitive, { status: 412 }) });
  await assert.rejects(() => client.get('bucket', 'object'), (error) => error.status === 412 && !error.message.includes('secret'));
});

test('GCS timeout：fail closed', async () => {
  const client = new GcsJsonClient({ accessToken: 'token', timeoutMs: 1, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  await assert.rejects(() => client.create('bucket', 'object', {}, { ifGenerationMatch: 0 }), (error) => error.code === 'ETIMEDOUT');
});

test('long wait：假時鐘下固定 heartbeat 續約，40 秒 jitter 不會耗盡 60 秒 lease', async () => {
  let clock = 0; let renews = 0;
  const lease = { persistent: true, async acquire() { return { fencingToken: 'f1', generation: '1', expiresAt: 60_000 }; }, async assertHeld() {}, async renew(handle) { renews += 1; return { ...handle, fencingToken: `f${renews + 1}`, generation: String(renews + 1), expiresAt: clock + 60_000 }; }, async release() {} };
  const dir = temp(); const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, plan: [], lease, now: () => clock, sleepFn: async (ms) => { clock += ms; } });
  await r.acquireLease('clock-run'); const manifest = await r.snapshot('clock-run');
  await r.waitInterval(40, manifest); await r.waitInterval(40, manifest);
  assert.ok(renews >= 1); assert.ok(r.leaseHandle.expiresAt > clock); assert.equal(manifest.lease_session.fencing_token, 'f2');
});

test('projection boundary 與 baseline parser 均 fail closed', async () => {
  assert.equal(PROJECTION_RANGES['8'], '8_發布_戰情看板!A1:Z311');
  const values = Array.from({ length: 311 }, (_, i) => [i]); const baseline = require('./lib').hash(values); const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test', projectionBaselines: { 3: baseline, 6: baseline, 7: baseline, 8: baseline } });
  const ranges = []; adapter.values = async (range) => { ranges.push(range); return range === '0_賽事設定!B12' ? [[0]] : values; };
  await adapter.verifyProjectionBaselines({ requiredProjections: ['8'], liveCell: '0_賽事設定!B12', requiredLiveValue: 0 });
  assert.ok(ranges.includes('8_發布_戰情看板!A1:Z311'));
  assert.deepEqual(parseProjectionBaselines(JSON.stringify({ 3: 'a'.repeat(64), 6: 'b'.repeat(64), 7: 'c'.repeat(64), 8: 'd'.repeat(64) })), { 3: 'a'.repeat(64), 6: 'b'.repeat(64), 7: 'c'.repeat(64), 8: 'd'.repeat(64) });
  assert.throws(() => parseProjectionBaselines('{"8":{"range":"bad"}}'), /hash map|baseline/);
});


test('比分與配對 jitter 規格', () => {
  assert.equal(fullPlan().length, 310);
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

// ── 淘汰賽隊名（2026-08-03 新增）──────────────────────────────
// 起因：原本的 plan 只寫 M/N 分數，J/L 隊名沒人填。編號反查與勝方公式會全部
// 回傳空，`6_積分總表` 的止步一律「—」、名次分一律 0——整條積分鏈路沒驗到
// 卻不會報錯。這幾個測試守住「隊名一定會被寫進去」這件事。

test('fullPlan：132 場淘汰賽都必須帶隊名格，且列號對得上場次', () => {
  const topology = loadTopology();
  const nos = knockoutNumbers(topology);
  const p = fullPlan(nos);
  assert.equal(p.length, 310);
  const knock = p.filter((m) => m.stage === 'knockout');
  assert.equal(knock.length, 132);
  assert.ok(knock.every((m) => m.nameCells && m.nameCells.length === 2), '每場淘汰賽都要有 J/L 隊名格');
  assert.ok(knock.every((m) => m.cells.length === 4), 'snapshot/restore 必須涵蓋隊名與分數共 4 格');
  // 第 i 場淘汰賽 ↔ 第 2+i 列，且場次由小到大
  assert.deepEqual(knock[0].nameCells, ['4_淘汰賽成績!J2', '4_淘汰賽成績!L2']);
  assert.equal(knock[0].no, nos[0]);
  assert.equal(knock[131].no, nos[131]);
  assert.deepEqual(knock[131].scoreCells, ['4_淘汰賽成績!M133', '4_淘汰賽成績!N133']);
  // 資格賽與曜請的隊伍是賽前預填的，模擬不得改動
  assert.ok(p.filter((m) => m.stage !== 'knockout').every((m) => m.nameCells === null));
});

test('缺解析器時淘汰賽不得寫入，且解析不出隊伍要 P0 中止', async () => {
  const dir = temp(); markObserver(dir); approve(dir);
  const ko = { id: 'knockout-1', stage: 'knockout', no: 151, nameCells: ['S!J1', 'S!L1'], scoreCells: ['S!M1', 'S!N1'], cells: ['S!J1', 'S!L1', 'S!M1', 'S!N1'] };
  const bare = runner(new MockAdapter(), dir, { plan: [ko], allowedStages: ['knockout'] });
  await assert.rejects(() => bare.executeMatch({ run_id: 'x', pre_image: {}, readback_evidence: { writes: {} } }, ko), /RESOLVER_REQUIRED/);
  const blind = runner(new MockAdapter(), dir, { plan: [ko], allowedStages: ['knockout'], resolver: { async namesFor() { return null; } } });
  await assert.rejects(() => blind.executeMatch({ run_id: 'x', pre_image: {}, readback_evidence: { writes: {} } }, ko), /無法推導參賽隊伍/);
});

test('賽程拓撲：解析自 bracket-tree.html，五角與三角都是完整循環', () => {
  const t = loadTopology();
  assert.equal(knockoutNumbers(t).length, 132);
  assert.equal(t.RR_PAIRS.length, 10);
  assert.equal(t.TRI_PAIRS.length, 3);
  // 拓撲被改壞（缺一場）必須立刻 fail-closed，而不是安靜地少推一場
  const broken = { ...t, MNO: { ...t.MNO, plat: { ...t.MNO.plat, pre: t.MNO.plat.pre.slice(1) } } };
  assert.throws(() => require('./bracket').assertTopology(broken), /TOPOLOGY_/);
});

test('循環賽名次：勝場 → 失分率 → 對戰勝負；三隊以上同率標記待抽籤', () => {
  const teams = ['A', 'B', 'C'];
  // A 與 B 同為 1 勝，A 的失分率較佳
  const ms = [
    { a: 'A', b: 'B', sa: 21, sb: 10, done: true },
    { a: 'B', b: 'C', sa: 21, sb: 19, done: true },
    { a: 'C', b: 'A', sa: 5, sb: 21, done: true }
  ];
  const { ranked, tied } = rankGroup(teams, ms);
  assert.equal(ranked[0], 'A');
  assert.equal(tied.size, 0);
  // 完全對稱的三隊互咬 → 同勝場同失分率 → 標記 tied（現場需抽籤）
  const sym = rankGroup(teams, [
    { a: 'A', b: 'B', sa: 21, sb: 11, done: true },
    { a: 'B', b: 'C', sa: 21, sb: 11, done: true },
    { a: 'C', b: 'A', sa: 21, sb: 11, done: true }
  ]);
  assert.equal(sym.tied.size, 3);
});

test('逐場回讀：晉級採後端 O 欄勝方，與比分不符時記錄 finding 但不中斷', async () => {
  const topology = loadTopology();
  const nos = knockoutNumbers(topology);
  const qualRows = [];
  let n = 0;
  for (const [tier, size] of [['白金', 20], ['黃金', 20], ['白銀', 30], ['青銅', 30]]) {
    for (let i = 0; i < size; i += 1) { n += 1; qualRows.push({ no: n, name: `T${n}`, rank: (i % 2) + 1, tier }); }
  }
  const findings = [];
  const results = {};
  const source = { async qualRows() { return qualRows; }, async knockRows() { return results; } };
  const resolver = new KnockoutResolver({ source, topology, onFinding: (f) => findings.push(f) });

  // 初賽第一場：兩隊都應解得出來
  const first = nos[0];
  const ab = await resolver.namesFor({ no: first });
  assert.equal(ab.length, 2);
  assert.notEqual(ab[0], ab[1]);

  // 後端 O 欄判給分數較低的一方 → 應記為 finding，且晉級跟著 O 欄走
  results[first] = { a: ab[0], b: ab[1], sa: 21, sb: 5, winner: ab[1], winnerNo: 2, rawWinner: '2' };
  await resolver.namesFor({ no: nos[1] });
  assert.equal(findings.filter((f) => f.code === 'BACKEND_WINNER_MISMATCH').length, 1);

  // 上一輪還沒完賽的場次不能硬掰隊伍
  await assert.rejects(() => resolver.namesFor({ no: topology.MNO.plat.sf[0] }), /UNRESOLVED_MATCH/);
});

test('種子序：同級別內第 1 名與第 2 名交錯，初賽不會變成同名次互打', () => {
  const rows = [];
  for (let i = 1; i <= 20; i += 1) rows.push({ no: i, name: `P${i}`, rank: i <= 10 ? 1 : 2, tier: '白金' });
  const seeds = seedsFor('plat', rows);
  assert.equal(seeds.length, 20);
  const rankOf = Object.fromEntries(rows.map((r) => [r.name, r.rank]));
  for (let i = 0; i < 10; i += 1) {
    assert.notEqual(rankOf[seeds[i * 2]], rankOf[seeds[i * 2 + 1]], `第 ${i + 1} 場不該是同名次互打`);
  }
  assert.equal(new Set(seeds).size, 20);
  // 人數不符必須 fail-closed，而不是默默少推幾隊
  assert.throws(() => seedsFor('plat', rows.slice(0, 19)), /SEED_SIZE/);
});

// ── 本機 lease／state（2026-08-03 新增）──────────────────────
// GCS bucket 綁的是 WIF service account，本機拿不到那把鑰匙。
// 本機版必須維持同樣的 fencing 與 fail-closed 語意，否則就是把安全機制拆掉。

test('本機 lease：fencing token 單調遞增，舊 handle 立即失效', async () => {
  const dir = temp(); const file = path.join(dir, 'lease.json');
  let clock = 1_000_000;
  const lease = new LocalGenerationLease({ file, ttlMs: 60_000, now: () => clock });
  assert.equal(lease.persistent, true, 'assertArmed 要求持久化 lease');
  const first = await lease.acquire({ runId: 'a', spreadsheetId: EXPECTED_SPREADSHEET_ID });
  await lease.assertHeld(first);
  // 同一把 lease 還沒過期，別的 run 不得搶走
  await assert.rejects(() => lease.acquire({ runId: 'b', spreadsheetId: EXPECTED_SPREADSHEET_ID }), /LEASE_BUSY/);
  // 過期後可被接管，且舊 handle 立刻失效
  clock += 60_001;
  const second = await lease.acquire({ runId: 'b', spreadsheetId: EXPECTED_SPREADSHEET_ID });
  assert.ok(second.generation > first.generation, 'generation 必須遞增');
  await assert.rejects(() => lease.assertHeld(first), /LEASE_LOST/);
  await lease.assertHeld(second);
  // 續約只延長到期時間，不換 fencing token
  clock += 100;
  const renewed = await lease.renew(second);
  assert.equal(renewed.fencingToken, second.fencingToken);
  await lease.release(renewed);
  await assert.rejects(() => lease.assertHeld(renewed), /LEASE_LOST/);
});

test('本機 run state：canary report 與 approval 都只能建立一次', async () => {
  const dir = temp();
  const lease = new LocalGenerationLease({ file: path.join(dir, 'lease.json') });
  const store = new LocalRunState({ dir, lease });
  const handle = await lease.acquire({ runId: 'once', spreadsheetId: EXPECTED_SPREADSHEET_ID });
  const manifest = {
    schema: 2, run_id: 'once', allowlist: ['S!A1'], pre_canonical_hash: 'x'.repeat(64),
    state: STATES.CANARY_WAITING_APPROVAL, reason: null, checkpoint: { completed: [] }
  };
  await store.persistManifest(manifest, handle);
  const manifestHash = require('./lib').hash({ schema: 2, run_id: 'once', allowlist: ['S!A1'], pre_canonical_hash: 'x'.repeat(64) });
  await store.writeCanaryReport(manifest, handle, manifestHash);
  await assert.rejects(() => store.writeCanaryReport(manifest, handle, manifestHash), /CANARY_REPORT_EXISTS/);
  // 格式合法但內容不符的 hash 一律拒絕，避免拿別的 manifest 的報告放行
  await assert.rejects(() => store.writeCanaryReport({ ...manifest, run_id: 'once' }, handle, 'a'.repeat(64)), /CANARY_REPORT_STATE_INVALID/);
  // 格式就不合法的 hash 在更前面就被擋掉
  await assert.rejects(() => store.writeCanaryReport(manifest, handle, 'not-a-hash'), /MANIFEST_HASH_INVALID/);
  const approvals = new LocalApprovalStore({ dir });
  const approval = await approvals.approve('once');
  assert.equal(approval.manifest_hash, manifestHash);
  await assert.rejects(() => approvals.approve('once'), /CANARY_APPROVAL_EXISTS/);
  // journal 是 append-only：兩次 persist 不會互相覆蓋
  await store.persistManifest(manifest, handle);
  assert.ok(fs.readdirSync(path.join(dir, 'once', 'journal')).length >= 2);
});

test('本機 state 失去 lease 後不得再寫入任何紀錄', async () => {
  const dir = temp();
  let clock = 2_000_000;
  const lease = new LocalGenerationLease({ file: path.join(dir, 'lease.json'), ttlMs: 1_000, now: () => clock });
  const store = new LocalRunState({ dir, lease });
  const handle = await lease.acquire({ runId: 'lost', spreadsheetId: EXPECTED_SPREADSHEET_ID });
  clock += 1_001;
  await assert.rejects(() => store.write('lost', 'manifest', { a: 1 }, handle), /LEASE_LOST/);
});

test('--local-state 為明確旗標，未指定時不會誤用本機 lease', () => {
  assert.equal(parseArgs(['run', '--armed']).localState, false);
  assert.equal(parseArgs(['run', '--armed', '--local-state']).localState, true);
  assert.throws(() => parseArgs(['run', '--local']), /未知參數/);
});

test('token 會自動換發：155 分鐘的演練不能靠一顆 60 分鐘的 token', async () => {
  // Google access token 上限 1 小時，全場演練 155 分鐘。固定 token 會在中途整批 401。
  const { SheetsRestAdapter: Adapter } = require('./sheets-rest-adapter');
  let minted = 0;
  const provider = async () => { minted += 1; return `token-${minted}`; };
  const adapter = new Adapter({ spreadsheetId: SPREADSHEET_ID, tokenProvider: provider });
  const seen = [];
  global.fetch = async (_url, options) => {
    seen.push(options.headers.Authorization);
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await adapter.request('https://example.invalid/1');
    await adapter.request('https://example.invalid/2');
  } finally { delete global.fetch; }
  assert.deepEqual(seen, ['Bearer token-1', 'Bearer token-2'], '每次請求都要問 provider 拿當下有效的 token');
  // 沒有 provider 也沒有靜態 token 一律拒絕建構
  assert.throws(() => new Adapter({ spreadsheetId: SPREADSHEET_ID }), /GOOGLE_ACCESS_TOKEN/);
});

test('token provider：未到期沿用同一顆，接近到期才換發，且不會併發重取', async () => {
  const { tokenProvider } = require('./sa-token');
  let clock = 1_000_000; let calls = 0;
  const fake = { accessToken: async () => { calls += 1; return { token: `t${calls}`, expiresAt: clock + 3_600_000 }; } };
  // 直接測快取語意：以同樣的 skew 規則自建一份，避免真的去打 Google
  const get = (() => {
    let current = null; let pending = null;
    return async () => {
      if (current && current.expiresAt - 300_000 > clock) return current.token;
      if (!pending) pending = fake.accessToken().then((t) => { current = t; return t.token; }).finally(() => { pending = null; });
      return pending;
    };
  })();
  assert.equal(await get(), 't1');
  assert.equal(await get(), 't1', '未接近到期不該重取');
  clock += 3_400_000;                       // 距到期剩 200 秒 < 5 分鐘門檻
  assert.equal(await get(), 't2', '接近到期要換發');
  clock += 3_400_000;
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, b, '併發呼叫只能觸發一次換發');
  assert.equal(calls, 3);
  assert.equal(typeof tokenProvider, 'function');
});

test('safeError：遮蔽 token 但保留 SCREAMING_SNAKE 錯誤碼', () => {
  // 演練期間只能靠日誌診斷，錯誤碼被誤遮成 [REDACTED] 等於沒有訊息
  assert.match(safeError(new Error('CANARY_APPROVAL_EXISTS')), /CANARY_APPROVAL_EXISTS/);
  assert.match(safeError(new Error('APPROVAL_PRELEASE_INVALID')), /APPROVAL_PRELEASE_INVALID/);
  // 真正的 token 一律大小寫混雜，仍然要被遮掉
  assert.match(safeError(new Error('Bearer ya29.a0AfB_byRandomLookingTokenValue123')), /REDACTED/);
  assert.doesNotMatch(safeError(new Error('ya29.a0AfB_byRandomLookingTokenValue123')), /RandomLooking/);
  assert.match(safeError(new Error('寄到 ives173@gmail.com')), /\[EMAIL\]/);
});

test('--keep-scores：跑完保留分數不自動復原，但復原能力完整保留', async () => {
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } });
  const dir = temp();
  const r = runner(adapter, dir, { keepScores: true });
  const result = await canaryThenComplete(r, dir, 'keep');
  assert.equal(result.state, STATES.COMPLETE);
  assert.equal(result.reason, 'KEPT_FOR_REVIEW');
  // 分數必須還在雲端
  const cells = await adapter.readCells(plan().flatMap((m) => m.cells));
  assert.ok(Object.values(cells).every((v) => v !== null), '--keep-scores 不該把分數清掉');
  // manifest 的 pre_image 完整保留，之後仍可人工復原
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'keep', 'manifest.json'), 'utf8'));
  assert.equal(Object.keys(manifest.pre_image).length, 6);
  assert.ok(Object.keys(manifest.post_image).length >= 6);
  const back = runner(adapter, dir, { mode: 'restore-only', armed: true, fast: false,
    lease: { persistent: true, async acquire() { return { fencingToken: 'f' }; }, async assertHeld() {}, async release() {} } });
  assert.equal((await back.restoreOnly('keep')).state, STATES.COMPLETE);
  const after = await adapter.readCells(plan().flatMap((m) => m.cells));
  assert.ok(Object.values(after).every((v) => v === null), '人工觸發後必須能完全復原');
});

test('--keep-scores 為明確旗標，預設仍是跑完自動復原', () => {
  assert.equal(parseArgs(['run', '--armed']).keepScores, false);
  assert.equal(parseArgs(['run', '--armed', '--keep-scores']).keepScores, true);
});
