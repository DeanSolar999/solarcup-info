'use strict';
const crypto = require('node:crypto');

// Durable run records stay in GCS, never in Actions artifacts. A generation
// condition plus an active lease is required before every record mutation.
class GcsRunState {
  constructor({ client, bucket, prefix, lease }) { this.client = client; this.bucket = bucket; this.prefix = prefix; this.lease = lease; }
  object(runId, name = 'manifest') { return `${this.prefix}/${runId}/${name}.json`; }
  async write(runId, name, body, handle) {
    await this.lease.assertHeld(handle);
    const object = this.object(runId, name);
    try {
      const current = await this.client.get(this.bucket, object);
      await this.lease.assertHeld(handle);
      return this.client.replace(this.bucket, object, body, { ifGenerationMatch: current.generation });
    } catch (error) {
      if (error.status !== 404) throw error;
      await this.lease.assertHeld(handle);
      return this.client.create(this.bucket, object, body, { ifGenerationMatch: 0 });
    }
  }
  async read(runId, name = 'manifest') { return (await this.client.get(this.bucket, this.object(runId, name))).body; }
  async writeCanaryReport(manifest, handle, manifestHash) {
    if (!/^[a-f0-9]{64}$/i.test(manifestHash || '')) throw new Error('MANIFEST_HASH_INVALID');
    await this.lease.assertHeld(handle);
    const current = await this.client.get(this.bucket, this.object(manifest.run_id, 'manifest'));
    await this.lease.assertHeld(handle);
    if (current.body.state !== 'CANARY_WAITING_APPROVAL' || current.body.reason || current.body.run_id !== manifest.run_id || manifestHash !== require('./lib').hash({ schema: current.body.schema, run_id: current.body.run_id, allowlist: current.body.allowlist, pre_canonical_hash: current.body.pre_canonical_hash })) throw new Error('CANARY_REPORT_STATE_INVALID');
    return this.client.create(this.bucket, this.object(manifest.run_id, 'canary-report'), {
      run_id: manifest.run_id, state: 'NORMAL_RESTORED', manifest_hash: manifestHash,
      pre_hash: manifest.pre_canonical_hash, post_hash: manifest.pre_canonical_hash, manifest_generation: current.generation
    }, { ifGenerationMatch: 0 });
  }
  async persistManifest(manifest, handle) {
    // Intent, checkpoint and restore state are independently addressable.
    await this.write(manifest.run_id, 'manifest', manifest, handle);
    await this.write(manifest.run_id, 'checkpoint', manifest.checkpoint, handle);
    const sequence = `${Date.now()}-${crypto.randomUUID()}`;
    await this.lease.assertHeld(handle);
    await this.client.create(this.bucket, this.object(manifest.run_id, `journal/${sequence}`), { state: manifest.state, reason: manifest.reason || null, at: new Date().toISOString() }, { ifGenerationMatch: 0 });
    if (manifest.in_flight) await this.write(manifest.run_id, 'intent', manifest.in_flight, handle);
    if (manifest.state === 'RESTORING') await this.write(manifest.run_id, 'restore', { state: manifest.state, reason: manifest.reason || null }, handle);
    if (['COMPLETE', 'RESTORE_FAILURE', 'MANUAL_HOLD', 'CANCELLED_RESTORE_REQUIRED'].includes(manifest.state)) await this.write(manifest.run_id, 'terminal', { state: manifest.state, reason: manifest.reason || null }, handle);
  }
}

class GcsApprovalStore {
  constructor({ client, bucket, prefix }) { this.client = client; this.bucket = bucket; this.prefix = prefix; }
  object(runId, name) { return `${this.prefix}/${runId}/${name}.json`; }
  async approve(runId) {
    const report = (await this.client.get(this.bucket, this.object(runId, 'canary-report'))).body;
    if (report.run_id !== runId || report.state !== 'NORMAL_RESTORED' || !/^[a-f0-9]{64}$/i.test(report.manifest_hash || '')) throw new Error('CANARY_REPORT_INVALID');
    const manifest = await this.client.get(this.bucket, this.object(runId, 'manifest'));
    const expectedHash = require('./lib').hash({ schema: manifest.body.schema, run_id: manifest.body.run_id, allowlist: manifest.body.allowlist, pre_canonical_hash: manifest.body.pre_canonical_hash });
    if (manifest.generation !== report.manifest_generation || manifest.body.state !== 'CANARY_WAITING_APPROVAL' || manifest.body.reason || expectedHash !== report.manifest_hash) throw new Error('CANARY_APPROVAL_STALE');
    try { const terminal = await this.client.get(this.bucket, this.object(runId, 'terminal')); if (terminal.body?.state === 'CANCELLED_RESTORE_REQUIRED') throw new Error('CANARY_APPROVAL_CANCELLED'); }
    catch (error) { if (error.status !== 404) throw error; }
    // No lease is acquired here: Environment approval cannot steal the Sheet lease.
    return this.client.create(this.bucket, this.object(runId, 'approval'), { run_id: runId, manifest_hash: report.manifest_hash, approved_at: new Date().toISOString() }, { ifGenerationMatch: 0 });
  }
}
module.exports = { GcsRunState, GcsApprovalStore };
