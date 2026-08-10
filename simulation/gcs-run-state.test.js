'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { GcsRunState, GcsApprovalStore } = require('./gcs-run-state');
const { hash } = require('./lib');

test('mock GCS：preimage/manifest/checkpoint/intent/restore 皆於 fencing 後持久化', async () => {
  const records = new Map(); let checks = 0;
  const client = {
    async get(_bucket, key) { if (!records.has(key)) { const error = new Error('missing'); error.status = 404; throw error; } return records.get(key); },
    async create(_bucket, key, body, condition) { assert.equal(condition.ifGenerationMatch, 0); const value = { generation: '1', body }; records.set(key, value); return value; },
    async replace(_bucket, key, body, condition) { assert.equal(condition.ifGenerationMatch, records.get(key).generation); const value = { generation: String(Number(records.get(key).generation) + 1), body }; records.set(key, value); return value; }
  };
  const lease = { async assertHeld(handle) { checks += 1; assert.equal(handle.fencingToken, 'wif-fence'); } };
  const store = new GcsRunState({ client, bucket: 'mock', prefix: 'state', lease });
  const manifest = { run_id: 'phase-resume', checkpoint: { completed: ['qual-1'] }, in_flight: { match: 'qual-2' }, state: 'RESTORING', reason: null, pre_image: { hidden: true } };
  await store.persistManifest(manifest, { fencingToken: 'wif-fence' });
  await store.writeIncidentReport('phase-resume', { outcome: 'FAILED' }, { fencingToken: 'wif-fence' });
  assert.deepEqual(await store.read('phase-resume'), manifest);
  assert.ok(records.has('state/phase-resume/checkpoint.json')); assert.ok(records.has('state/phase-resume/intent.json')); assert.ok(records.has('state/phase-resume/restore.json')); assert.ok([...records.keys()].some((key) => key.startsWith('state/phase-resume/journal/'))); assert.ok(checks >= 4);
  assert.equal(records.get('state/phase-resume/restore-incident-report.json').body.outcome, 'FAILED');
});

test('journal 每次 append 都是新 key，MANUAL_HOLD 與 COMPLETE 都寫入 terminal', async () => {
  const records = new Map(); let serial = 0;
  const client = {
    async get(_bucket, key) { if (!records.has(key)) throw Object.assign(new Error('missing'), { status: 404 }); return records.get(key); },
    async create(_bucket, key, body) { const value = { generation: String(++serial), body }; records.set(key, value); return value; },
    async replace(_bucket, key, body) { const value = { generation: String(++serial), body }; records.set(key, value); return value; }
  };
  const store = new GcsRunState({ client, bucket: 'mock', prefix: 'state', lease: { async assertHeld() {} } });
  const manifest = { run_id: 'terminal-run', checkpoint: {}, state: 'MANUAL_HOLD', reason: 'conflict' };
  await store.persistManifest(manifest, {});
  manifest.state = 'COMPLETE'; manifest.reason = 'NORMAL_RESTORED';
  await store.persistManifest(manifest, {});
  assert.equal([...records.keys()].filter((key) => key.includes('/journal/')).length, 2);
  assert.equal(records.get('state/terminal-run/terminal.json').body.state, 'COMPLETE');
});

test('approval 只可由同 run 的正常 canary report 建立一次，重播為 412', async () => {
  const manifest = { schema: 2, run_id: 'approved-run', allowlist: [], pre_canonical_hash: 'p', state: 'CANARY_WAITING_APPROVAL', reason: null };
  const manifestHash = hash({ schema: manifest.schema, run_id: manifest.run_id, allowlist: manifest.allowlist, pre_canonical_hash: manifest.pre_canonical_hash }); let approvalWrites = 0;
  const client = {
    async get(_bucket, key) {
      if (/canary-report\.json$/.test(key)) return { body: { run_id: 'approved-run', state: 'NORMAL_RESTORED', manifest_hash: manifestHash, manifest_generation: '7' } };
      if (/manifest\.json$/.test(key)) return { generation: '7', body: manifest };
      throw Object.assign(new Error('missing'), { status: 404 });
    },
    async create(_bucket, key, body, condition) { assert.match(key, /approval\.json$/); assert.equal(condition.ifGenerationMatch, 0); approvalWrites += 1; if (approvalWrites > 1) throw Object.assign(new Error('exists'), { status: 412 }); return { generation: '1', body }; }
  };
  const approvals = new GcsApprovalStore({ client, bucket: 'mock', prefix: 'state' });
  const made = await approvals.approve('approved-run');
  assert.equal(made.body.manifest_hash, manifestHash);
  await assert.rejects(() => approvals.approve('approved-run'), (error) => error.status === 412);
});

test('canary report 建立途中若取消改寫 manifest，approval 必須拒絕 stale report', async () => {
  const manifest = { schema: 2, run_id: 'cancel-race', allowlist: [], pre_canonical_hash: 'p', state: 'CANCELLED_RESTORE_REQUIRED', reason: 'CANCELLED_RESTORE_REQUIRED' };
  const manifestHash = hash({ schema: 2, run_id: 'cancel-race', allowlist: [], pre_canonical_hash: 'p' });
  const approvals = new GcsApprovalStore({ client: {
    async get(_bucket, key) {
      if (/canary-report/.test(key)) return { body: { run_id: 'cancel-race', state: 'NORMAL_RESTORED', manifest_hash: manifestHash, manifest_generation: '7' } };
      if (/manifest/.test(key)) return { generation: '8', body: manifest };
      return { body: { state: 'CANCELLED_RESTORE_REQUIRED' } };
    }, async create() { throw new Error('must not approve'); }
  }, bucket: 'mock', prefix: 'state' });
  await assert.rejects(() => approvals.approve('cancel-race'), /CANARY_APPROVAL_STALE/);
});
