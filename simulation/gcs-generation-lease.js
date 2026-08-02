'use strict';

// Contract-only lease. The injected client must implement get/create/replace/
// delete with ifGenerationMatch; no credentials or network client lives here.
class GcsGenerationLease {
  constructor({ client, bucket, object = 'solarcup-simulation/lease.json', now = () => Date.now(), timeoutMs = 10_000 }) {
    this.client = client; this.bucket = bucket; this.object = object; this.now = now; this.timeoutMs = timeoutMs; this.persistent = Boolean(client && bucket);
  }
  async call(method, ...args) {
    let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('GCS lease timeout'); error.code = 'ETIMEDOUT'; reject(error); }, this.timeoutMs); });
    try { return await Promise.race([this.client[method](...args, { signal: AbortSignal.timeout(this.timeoutMs) }), timeout]); } finally { clearTimeout(timer); }
  }
  async acquire({ runId }) {
    if (!this.persistent) throw new Error('GCS lease 未設定 bucket/client');
    const record = { owner_run_id: runId, expires_at: new Date(this.now() + 60_000).toISOString() };
    try {
      const result = await this.call('create', this.bucket, this.object, record, { ifGenerationMatch: 0 });
      return { fencingToken: String(result.generation), generation: result.generation, runId };
    } catch (error) { throw new Error(`GCS_LEASE_ACQUIRE_FAILED:${error.code || 'unknown'}`); }
  }
  async assertHeld(handle) {
    const current = await this.call('get', this.bucket, this.object);
    if (String(current.generation) !== String(handle.generation) || current.body.owner_run_id !== handle.runId || Date.parse(current.body.expires_at) <= this.now()) throw new Error('GCS_LEASE_LOST');
  }
  async release(handle) { await this.call('delete', this.bucket, this.object, { ifGenerationMatch: handle.generation }); }
}
module.exports = { GcsGenerationLease };
