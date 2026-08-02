'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SimulationRunner, EXPECTED_SPREADSHEET_ID, cellForNumber, parseArgs, parseProjectionBaselines } = require('./runner');
const { MockAdapter } = require('./mock-adapter');
const { SheetsRestAdapter, SPREADSHEET_ID, PROJECTION_RANGES } = require('./sheets-rest-adapter');
const { GcsJsonClient, GcsGenerationLease } = require('./gcs-generation-lease');
const { STATES, assertLegalScore, pairedJitter, sameCells, scoreFor, writeJson, safeError } = require('./lib');
const marker = require('./marker');

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

test('GCS timeout 與 marker state root：均 fail closed', async () => {
  const client = new GcsJsonClient({ accessToken: 'token', timeoutMs: 1, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  await assert.rejects(() => client.create('bucket', 'object', {}, { ifGenerationMatch: 0 }), (error) => error.code === 'ETIMEDOUT');
  assert.throws(() => marker.main(['observer-heartbeat', '--state-dir', temp(), '--run-id', 'safe-run', '--fencing-token', 'f', '--manifest-hash', 'h']), /固定 state root/);
});

test('long wait：假時鐘下固定 heartbeat 續約，40 秒 jitter 不會耗盡 60 秒 lease', async () => {
  let clock = 0; let renews = 0;
  const lease = { persistent: true, async acquire() { return { fencingToken: 'f1', generation: '1', expiresAt: 60_000 }; }, async assertHeld() {}, async renew(handle) { renews += 1; return { ...handle, fencingToken: `f${renews + 1}`, generation: String(renews + 1), expiresAt: clock + 60_000 }; }, async release() {} };
  const dir = temp(); const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, plan: [], lease, now: () => clock, sleepFn: async (ms) => { clock += ms; } });
  await r.acquireLease('clock-run'); const manifest = await r.snapshot('clock-run');
  await r.waitInterval(40, manifest); await r.waitInterval(40, manifest);
  assert.ok(renews >= 1); assert.ok(r.leaseHandle.expiresAt > clock); assert.equal(manifest.lease_session.fencing_token, 'f2');
});

test('marker wait：ENOENT 僅視為 pending，等待期間 heartbeat renew 後完成並保留 NORMAL_RESTORED reason', async () => {
  let clock = 0; const dir = temp(); let r;
  const lease = { persistent: true, async acquire() { return { fencingToken: 'new-fence', generation: '1', expiresAt: 60_000 }; }, async assertHeld() {}, async renew(handle) { return { ...handle, generation: '2', fencingToken: 'new-fence-2', expiresAt: clock + 60_000 }; }, async release() {} };
  const adapter = new MockAdapter({}, { armedGateResult: { verified: true, liveSwitch: 0, projections: { 8: 'h', 3: 'h', 6: 'h', 7: 'h' } } });
  const sleepFn = async (ms) => {
    clock += ms;
    if (clock === 50_000) {
      const manifest = require('./lib').readJson(r.manifestPath('delayed-marker'));
      const value = { run_id: 'delayed-marker', fencing_token: r.leaseHandle.fencingToken, manifest_hash: r.manifestHash(manifest), expires_at: new Date(clock + 60_000).toISOString() };
      writeJson(r.markerPath('delayed-marker', 'canary-observed'), value); writeJson(r.markerPath('delayed-marker', 'canary-approved'), value);
    }
  };
  r = new SimulationRunner({ adapter, stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease, plan: [], now: () => clock, sleepFn, markerWaitMs: 70_000 });
  const manifest = await r.snapshot('delayed-marker'); manifest.state = STATES.CANARY_WAITING_APPROVAL; r.save(manifest);
  const result = await r.start('delayed-marker');
  assert.equal(result.state, STATES.COMPLETE); assert.equal(result.reason, 'NORMAL_RESTORED'); assert.equal(r.leaseHandle.fencingToken, 'new-fence-2');
});

test('expires_at、projection boundary 與 baseline parser 均 fail closed', async () => {
  const dir = temp(); const lease = { persistent: true, async acquire() { return { fencingToken: 'fence', expiresAt: Date.now() + 60_000 }; }, async assertHeld() {}, async release() {} };
  const r = new SimulationRunner({ adapter: new MockAdapter(), stateDir: dir, spreadsheetId: EXPECTED_SPREADSHEET_ID, mode: 'run', armed: true, lease });
  await r.acquireLease('bad-expiry'); const manifest = await r.snapshot('bad-expiry');
  writeJson(r.markerPath('bad-expiry', 'observer-heartbeat'), { run_id: 'bad-expiry', fencing_token: 'fence', manifest_hash: r.manifestHash(manifest), expires_at: 'not-a-date' });
  assert.throws(() => r.requireMarker(manifest, 'observer-heartbeat'), (error) => error.code === 'MARKER_INVALID');
  assert.equal(PROJECTION_RANGES['8'], '8_發布_戰情看板!A1:Z311');
  const values = Array.from({ length: 311 }, (_, i) => [i]); const baseline = require('./lib').hash(values); const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: 'test', projectionBaselines: { 3: baseline, 6: baseline, 7: baseline, 8: baseline } });
  const ranges = []; adapter.values = async (range) => { ranges.push(range); return range === '0_賽事設定!B12' ? [[0]] : values; };
  await adapter.verifyProjectionBaselines({ requiredProjections: ['8'], liveCell: '0_賽事設定!B12', requiredLiveValue: 0 });
  assert.ok(ranges.includes('8_發布_戰情看板!A1:Z311'));
  assert.deepEqual(parseProjectionBaselines(JSON.stringify({ 3: 'a'.repeat(64), 6: 'b'.repeat(64), 7: 'c'.repeat(64), 8: 'd'.repeat(64) })), { 3: 'a'.repeat(64), 6: 'b'.repeat(64), 7: 'c'.repeat(64), 8: 'd'.repeat(64) });
  assert.throws(() => parseProjectionBaselines('{"8":{"range":"bad"}}'), /hash map|baseline/);
});

test('marker：root/run/markers/manifest symlink 全部拒絕', () => {
  const base = temp(); const external = temp(); const runId = 'marker-safe';
  const invoke = (root) => marker.main(['observer-heartbeat', '--state-dir', root, '--run-id', runId, '--fencing-token', 'f', '--manifest-hash', 'h'], { root });
  const rootLink = path.join(base, 'root-link'); fs.symlinkSync(external, rootLink); assert.throws(() => invoke(rootLink), /UNSAFE_DIRECTORY/);
  const root = path.join(base, 'root'); fs.mkdirSync(root); fs.symlinkSync(external, path.join(root, runId)); assert.throws(() => invoke(root), /UNSAFE_DIRECTORY/);
  fs.unlinkSync(path.join(root, runId)); fs.mkdirSync(path.join(root, runId)); const manifest = { schema: 2, run_id: runId, allowlist: [], pre_canonical_hash: 'x' }; writeJson(path.join(root, runId, 'manifest.json'), manifest); const digest = require('./lib').hash(manifest);
  fs.symlinkSync(external, path.join(root, 'markers')); assert.throws(() => marker.main(['observer-heartbeat', '--state-dir', root, '--run-id', runId, '--fencing-token', 'f', '--manifest-hash', digest], { root }), /UNSAFE_DIRECTORY/);
  fs.unlinkSync(path.join(root, 'markers')); fs.unlinkSync(path.join(root, runId, 'manifest.json')); writeJson(path.join(external, 'manifest.json'), manifest); fs.symlinkSync(path.join(external, 'manifest.json'), path.join(root, runId, 'manifest.json'));
  assert.throws(() => marker.main(['observer-heartbeat', '--state-dir', root, '--run-id', runId, '--fencing-token', 'f', '--manifest-hash', digest], { root }), /UNSAFE_FILE/);
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
