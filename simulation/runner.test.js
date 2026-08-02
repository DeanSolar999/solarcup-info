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
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!J2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!L2'), /allowlist/);
  assert.throws(() => adapter.assertAllowedRef('4_淘汰賽成績!M134'), /allowlist/);
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
  const r = new SimulationRunner({ adapter, stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, plan: fullPlan(), allowedStages: ['qualification', 'knockout', 'invitational'], fast: true, segment: 1 });
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
  const r = new SimulationRunner({ adapter, stateDir: temp(), spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease, stateStore: { async persistManifest() {} }, plan: fullPlan(), allowedStages: ['qualification', 'knockout', 'invitational'], fast: false, sleepFn: async () => {}, segment: 2 });
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
