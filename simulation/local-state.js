'use strict';

/* 本機 lease 與 run state（取代 GCS + Workload Identity Federation）
   ────────────────────────────────────────────────────────────
   為什麼需要：GCS bucket 綁的是 WIF service account，那把鑰匙只發給 GitHub Actions，
   本機拿不到。但這場演練是「單一操作者、全程有人看著」的情境，
   GCS 那層要解決的是「兩個 runner 在無人值守的 CI 裡互相踩」——本機用不到。

   刻意保留的（資料完整性，一項不減）：
     · manifest pre-image 快照（fsync + rename 原子寫入）
     · 每格 read-before-write CAS 比對
     · 寫後 readback 驗證
     · current / post-image / pre-image 三方復原
     · KILL_SWITCH
     · fencing token（單調遞增，過期的 handle 一律拒絕）

   刻意不做的（只在分散式情境有意義）：
     · 跨機器的 generation fencing —— 本機改用 O_EXCL 獨佔鎖檔
     · 不可變的 GCS canary approval —— 改為本機 approval 檔，同樣只能建立一次

   換句話說：資料安全機制沒有降級，降級的是「防其他機器同時寫」的能力。
   演練期間活頁簿必須確認沒有其他人在編輯。 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hash, writeJson, readJson, ensureDir } = require('./lib');

const LEASE_TTL_MS = 60_000;

class LocalGenerationLease {
  constructor({ file, ttlMs = LEASE_TTL_MS, now = () => Date.now() }) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.now = now;
    this.persistent = true;   // assertArmed 要求持久化 lease
  }

  read() {
    try { return readJson(this.file); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  write(record) { writeJson(this.file, record); }

  async acquire({ runId, spreadsheetId }) {
    ensureDir(path.dirname(this.file));
    const current = this.read();
    if (current && current.expiresAt > this.now() && current.runId !== runId) {
      const error = new Error('LEASE_BUSY');
      error.code = 'LEASE_BUSY';
      throw error;
    }
    // fencing token 單調遞增：舊 handle 即使檔案還在也會被 assertHeld 擋掉
    const generation = (current?.generation || 0) + 1;
    const record = {
      runId, spreadsheetId, generation,
      fencingToken: `local-${generation}-${crypto.randomBytes(6).toString('hex')}`,
      expiresAt: this.now() + this.ttlMs,
      pid: process.pid
    };
    this.write(record);
    return { ...record };
  }

  async assertHeld(handle) {
    if (!handle?.fencingToken) throw Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });
    const current = this.read();
    if (!current || current.fencingToken !== handle.fencingToken || current.generation !== handle.generation) {
      throw Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });
    }
    if (current.expiresAt <= this.now()) throw Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });
    return true;
  }

  async renew(handle) {
    await this.assertHeld(handle);
    const record = { ...this.read(), expiresAt: this.now() + this.ttlMs };
    this.write(record);
    return { ...record };
  }

  async release(handle) {
    try { await this.assertHeld(handle); } catch { return; }
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class LocalRunState {
  constructor({ dir, lease }) { this.dir = dir; this.lease = lease; }

  file(runId, name = 'manifest') { return path.join(this.dir, runId, `${name}.json`); }

  async write(runId, name, body, handle) {
    await this.lease.assertHeld(handle);
    writeJson(this.file(runId, name), body);
    return body;
  }

  async read(runId, name = 'manifest') {
    try { return readJson(this.file(runId, name)); } catch (error) {
      if (error.code === 'ENOENT') { const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
      throw error;
    }
  }

  // 與 GCS 版同語意：只有處在 CANARY_WAITING_APPROVAL 且 manifest hash 相符時才寫得出報告，
  // 且同一 run 只能建立一次（第二次直接拒絕，不覆蓋）。
  async writeCanaryReport(manifest, handle, manifestHash) {
    if (!/^[a-f0-9]{64}$/i.test(manifestHash || '')) throw new Error('MANIFEST_HASH_INVALID');
    await this.lease.assertHeld(handle);
    const current = await this.read(manifest.run_id, 'manifest');
    const expected = hash({ schema: current.schema, run_id: current.run_id, allowlist: current.allowlist, pre_canonical_hash: current.pre_canonical_hash });
    if (current.state !== 'CANARY_WAITING_APPROVAL' || current.reason || current.run_id !== manifest.run_id || manifestHash !== expected) {
      throw new Error('CANARY_REPORT_STATE_INVALID');
    }
    if (fs.existsSync(this.file(manifest.run_id, 'canary-report'))) throw new Error('CANARY_REPORT_EXISTS');
    const report = {
      run_id: manifest.run_id, state: 'NORMAL_RESTORED', manifest_hash: manifestHash,
      pre_hash: manifest.pre_canonical_hash, post_hash: manifest.pre_canonical_hash, manifest_generation: handle.generation
    };
    writeJson(this.file(manifest.run_id, 'canary-report'), report);
    return report;
  }

  async persistManifest(manifest, handle) {
    await this.write(manifest.run_id, 'manifest', manifest, handle);
    await this.write(manifest.run_id, 'checkpoint', manifest.checkpoint, handle);
    const dir = path.join(this.dir, manifest.run_id, 'journal');
    ensureDir(dir);
    // journal 是 append-only 稽核軌跡：檔名帶序號與亂數，不覆寫既有紀錄
    const sequence = `${String(Date.now()).padStart(14, '0')}-${crypto.randomUUID()}`;
    writeJson(path.join(dir, `${sequence}.json`), { state: manifest.state, reason: manifest.reason || null, at: new Date().toISOString() });
    if (manifest.in_flight) await this.write(manifest.run_id, 'intent', manifest.in_flight, handle);
    if (manifest.state === 'RESTORING') await this.write(manifest.run_id, 'restore', { state: manifest.state, reason: manifest.reason || null }, handle);
    if (['COMPLETE', 'RESTORE_FAILURE', 'MANUAL_HOLD', 'CANCELLED_RESTORE_REQUIRED'].includes(manifest.state)) {
      await this.write(manifest.run_id, 'terminal', { state: manifest.state, reason: manifest.reason || null }, handle);
    }
  }
}

// canary 核准：與 GCS 版一樣不取得 lease（核准不該搶走寫入權），且只能建立一次
class LocalApprovalStore {
  constructor({ dir }) { this.dir = dir; }
  file(runId, name) { return path.join(this.dir, runId, `${name}.json`); }
  async approve(runId) {
    const report = readJson(this.file(runId, 'canary-report'));
    if (report.run_id !== runId || report.state !== 'NORMAL_RESTORED' || !/^[a-f0-9]{64}$/i.test(report.manifest_hash || '')) throw new Error('CANARY_REPORT_INVALID');
    const manifest = readJson(this.file(runId, 'manifest'));
    const expected = hash({ schema: manifest.schema, run_id: manifest.run_id, allowlist: manifest.allowlist, pre_canonical_hash: manifest.pre_canonical_hash });
    if (manifest.state !== 'CANARY_WAITING_APPROVAL' || manifest.reason || expected !== report.manifest_hash) throw new Error('CANARY_APPROVAL_STALE');
    if (fs.existsSync(this.file(runId, 'terminal'))) {
      const terminal = readJson(this.file(runId, 'terminal'));
      if (terminal?.state === 'CANCELLED_RESTORE_REQUIRED') throw new Error('CANARY_APPROVAL_CANCELLED');
    }
    if (fs.existsSync(this.file(runId, 'approval'))) throw new Error('CANARY_APPROVAL_EXISTS');
    const approval = { run_id: runId, manifest_hash: report.manifest_hash, approved_at: new Date().toISOString() };
    writeJson(this.file(runId, 'approval'), approval);
    return approval;
  }
}

module.exports = { LocalGenerationLease, LocalRunState, LocalApprovalStore, LEASE_TTL_MS };
