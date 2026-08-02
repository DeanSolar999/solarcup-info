'use strict';

class GcsJsonClient {
  constructor({ accessToken, timeoutMs = 10_000, fetchImpl = fetch }) { if (!accessToken) throw new Error('缺少 GOOGLE_ACCESS_TOKEN'); this.accessToken = accessToken; this.timeoutMs = timeoutMs; this.fetch = fetchImpl; }
  async request(url, options = {}) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try { response = await this.fetch(url, { ...options, signal: controller.signal, headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) } }); }
    catch (error) { if (controller.signal.aborted || error.name === 'AbortError') { const timed = new Error('GCS API timeout'); timed.code = 'ETIMEDOUT'; throw timed; } throw error; }
    finally { clearTimeout(timer); }
    const text = await response.text(); if (!response.ok) { const error = new Error(`GCS API ${response.status}`); error.status = response.status; throw error; }
    return text ? JSON.parse(text) : {};
  }
  objectUrl(bucket, object, params = {}) { const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`); Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v))); return url; }
  uploadUrl(bucket, params = {}) { const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`); Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v))); return url; }
  async create(bucket, object, body, condition) { return this.request(this.uploadUrl(bucket, { uploadType: 'media', name: object, ifGenerationMatch: condition.ifGenerationMatch }), { method: 'POST', body: JSON.stringify(body) }); }
  async get(bucket, object) {
    const meta = await this.request(this.objectUrl(bucket, object));
    const media = new URL(`https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`);
    media.searchParams.set('alt', 'media'); media.searchParams.set('generation', String(meta.generation));
    return { generation: meta.generation, body: await this.request(media) };
  }
  // GCS media insert is also the conditional replacement endpoint. It must be
  // POSTed to upload/storage/v1; JSON API object PUT is not a media upload.
  async replace(bucket, object, body, condition) { return this.request(this.uploadUrl(bucket, { uploadType: 'media', name: object, ifGenerationMatch: condition.ifGenerationMatch }), { method: 'POST', body: JSON.stringify(body) }); }
  async delete(bucket, object, condition) { return this.request(this.objectUrl(bucket, object, { ifGenerationMatch: condition.ifGenerationMatch }), { method: 'DELETE' }); }
}

class GcsGenerationLease {
  constructor({ client, bucket, object = 'solarcup-simulation/lease.json', now = () => Date.now(), timeoutMs = 10_000, ttlMs = 60_000 }) { this.client = client; this.bucket = bucket; this.object = object; this.now = now; this.timeoutMs = timeoutMs; this.ttlMs = ttlMs; this.persistent = Boolean(client && bucket); }
  async call(method, ...args) { let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('GCS lease timeout'); error.code = 'ETIMEDOUT'; reject(error); }, this.timeoutMs); }); try { return await Promise.race([this.client[method](...args, { signal: AbortSignal.timeout(this.timeoutMs) }), timeout]); } finally { clearTimeout(timer); } }
  record(runId) { const expiresAt = this.now() + this.ttlMs; return { expiresAt, body: { owner_run_id: runId, expires_at: new Date(expiresAt).toISOString() } }; }
  lost(error) { const failure = new Error('GCS_LEASE_LOST'); failure.code = 'LEASE_LOST'; failure.cause = error; return failure; }
  async acquire({ runId }) {
    if (!this.persistent) throw new Error('GCS lease 未設定 bucket/client');
    const record = this.record(runId);
    try {
      const result = await this.call('create', this.bucket, this.object, record.body, { ifGenerationMatch: 0 });
      return { fencingToken: String(result.generation), generation: result.generation, runId, expiresAt: record.expiresAt };
    } catch (error) {
      if (error.status !== 412) { const failure = new Error(`GCS_LEASE_ACQUIRE_FAILED:${error.status || error.code || 'unknown'}`); failure.code = 'LEASE_ACQUIRE_FAILED'; throw failure; }
      // A crashed runner leaves the lease object behind. Only an already
      // expired generation may be conditionally taken over (restore-only uses
      // the same path), never a live owner.
      let current;
      try { current = await this.call('get', this.bucket, this.object); } catch (getError) { throw this.lost(getError); }
      const currentExpiry = Date.parse(current.body?.expires_at);
      if (!Number.isFinite(currentExpiry)) throw this.lost();
      if (currentExpiry > this.now()) { const failure = new Error('GCS_LEASE_ACQUIRE_FAILED:412'); failure.code = 'LEASE_ACQUIRE_FAILED'; throw failure; }
      try {
        const result = await this.call('replace', this.bucket, this.object, record.body, { ifGenerationMatch: current.generation });
        return { fencingToken: String(result.generation), generation: result.generation, runId, expiresAt: record.expiresAt };
      } catch (takeoverError) { throw this.lost(takeoverError); }
    }
  }
  async assertHeld(handle) { const current = await this.call('get', this.bucket, this.object); const expiry = Date.parse(current.body?.expires_at); if (String(current.generation) !== String(handle.generation) || current.body?.owner_run_id !== handle.runId || !Number.isFinite(expiry) || expiry <= this.now()) throw this.lost(); }
  async renew(handle) {
    if (!Number.isFinite(handle.expiresAt) || handle.expiresAt <= this.now()) throw this.lost();
    const record = this.record(handle.runId);
    try { const result = await this.call('replace', this.bucket, this.object, record.body, { ifGenerationMatch: handle.generation }); return { ...handle, fencingToken: String(result.generation), generation: result.generation, expiresAt: record.expiresAt }; }
    catch (error) { if (error.status === 412) throw this.lost(error); throw error; }
  }
  async release(handle) { try { await this.call('delete', this.bucket, this.object, { ifGenerationMatch: handle.generation }); } catch (error) { if (error.status === 412) throw this.lost(error); throw error; } }
}
module.exports = { GcsJsonClient, GcsGenerationLease };
