#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  STATES, hash, same, sameCells, canonicalCells, readbackEvidence, makeRunId, scoreFor, assertLegalScore, pairedJitter,
  ensureDir, writeJson, readJson, appendJournal, defaultPlan, fullPlan, isKillSwitchSet, safeError
} = require('./lib');
const { MockAdapter } = require('./mock-adapter');
const { SheetsRestAdapter } = require('./sheets-rest-adapter');
const { GcsJsonClient, GcsGenerationLease } = require('./gcs-generation-lease');
const { GcsRunState } = require('./gcs-run-state');
const { KnockoutResolver, CloudSource, ScriptedResolver } = require('./knockout-resolver');
const { LocalGenerationLease, LocalRunState } = require('./local-state');

const EXPECTED_SPREADSHEET_ID = '1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
const RUN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{1,72}$/;
const SEGMENTS = Object.freeze([[0, 75], [75, 150], [150, 216], [216, 282], [282, 310]]);

function cellForNumber(number) { return { userEnteredValue: { numberValue: number } }; }
function cellForString(text) { return { userEnteredValue: { stringValue: text } }; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isTransient(error) { return ['ETIMEDOUT', 'ECONNRESET'].includes(error.code) || error.status === 429 || error.status >= 500; }
function parseProjectionBaselines(text) {
  let baselines;
  try { baselines = JSON.parse(text); } catch { throw new Error('SOLAR_CUP_PROJECTION_BASELINES 必須為 JSON hash map'); }
  if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) throw new Error('SOLAR_CUP_PROJECTION_BASELINES 必須為 JSON hash map');
  for (const id of ['3', '6', '7', '8']) if (!/^[a-f0-9]{64}$/i.test(baselines[id] || '')) throw new Error(`projection ${id} baseline 必須為 SHA-256 hash`);
  return Object.fromEntries(['3', '6', '7', '8'].map((id) => [id, baselines[id].toLowerCase()]));
}

class InMemoryLease {
  constructor() { this.persistent = false; }
  async acquire() { return { fencingToken: `local-${Date.now()}` }; }
  async assertHeld() { return true; }
  async release() { return true; }
}

class SimulationRunner {
  constructor({ adapter, stateDir, mode = 'dry-run', armed = false, canaryOnly = false, resumeOnly = false, segment = null, spreadsheetId, plan = defaultPlan(), fast = false, stopAfter = null, random = Math.random, resolver = null, allowedStages = ['qualification'], lease = new InMemoryLease(), stateStore = null, sleepFn = sleep, now = () => Date.now() }) {
    this.adapter = adapter;
    this.stateDir = stateDir;
    this.mode = mode;
    this.armed = armed;
    this.canaryOnly = canaryOnly; this.resumeOnly = resumeOnly;
    this.segment = segment;
    this.spreadsheetId = spreadsheetId;
    this.plan = plan;
    this.fast = fast;
    this.stopAfter = stopAfter;
    this.random = random;
    // 淘汰賽隊名解析器。null＝不寫隊名（僅供既有的資格賽-only 測試沿用）。
    this.resolver = resolver;
    this.findings = [];
    this.allowedStages = new Set(allowedStages);
    this.lease = lease;
    this.stateStore = stateStore;
    this.sleepFn = sleepFn;
    this.now = now;
    this.leaseHandle = null;
    this.stopRequested = false;
    this.activeManifest = null;
  }

  assertArmed() {
    if (this.armed && this.fast) throw new Error('--fast 與 --armed 不可同時使用');
    if (this.mode !== 'run' && this.mode !== 'restore-only') return;
    if (!this.armed || this.spreadsheetId !== EXPECTED_SPREADSHEET_ID) {
      throw new Error('寫入被拒絕：run／restore-only 必須同時指定 --armed 與正確 Spreadsheet allowlist');
    }
    if (!this.lease?.persistent) throw new Error('寫入被拒絕：未提供持久化 external lease／fencing');
  }

  async acquireLease(runId) {
    this.leaseHandle = await this.lease.acquire({ runId, spreadsheetId: this.spreadsheetId });
    if (!this.leaseHandle?.fencingToken) throw new Error('lease 未提供 fencing token');
    await this.lease.assertHeld(this.leaseHandle);
    return this.leaseHandle;
  }

  leaseSession() {
    if (!this.leaseHandle) return null;
    return { fencing_token: this.leaseHandle.fencingToken, generation: this.leaseHandle.generation ?? null, expires_at: this.leaseHandle.expiresAt ? new Date(this.leaseHandle.expiresAt).toISOString() : null };
  }

  async watchdog(manifest = null) {
    if (!this.leaseHandle && this.mode === 'dry-run') return true;
    if (!this.leaseHandle) throw Object.assign(new Error('lease 不存在'), { p0: true });
    if (this.leaseHandle.expiresAt && (!Number.isFinite(this.leaseHandle.expiresAt) || this.leaseHandle.expiresAt <= this.now())) throw Object.assign(new Error('LEASE_EXPIRED'), { p0: true, code: 'LEASE_LOST' });
    await this.lease.assertHeld(this.leaseHandle);
    if (this.leaseHandle.expiresAt && this.now() + 15_000 >= this.leaseHandle.expiresAt) {
      try { this.leaseHandle = await this.lease.renew(this.leaseHandle); }
      catch (error) { throw Object.assign(error, { p0: true }); }
      if (manifest) {
        manifest.lease_session = this.leaseSession();
        await this.persist(manifest);
        appendJournal(this.runDir(manifest.run_id), { type: 'LEASE_RENEWED', fencing_token: this.leaseHandle.fencingToken, generation: this.leaseHandle.generation });
      }
    }
    return true;
  }

  runDir(runId) { if (!RUN_ID.test(runId)) throw new Error('非法 run_id'); return path.join(this.stateDir, runId); }
  manifestPath(runId) { return path.join(this.runDir(runId), 'manifest.json'); }
  save(manifest) { writeJson(this.manifestPath(manifest.run_id), manifest); }
  async persist(manifest) { this.save(manifest); if (this.stateStore && this.mode !== 'dry-run') await this.stateStore.persistManifest(manifest, this.leaseHandle); }

  async precheck({ requireProjections = true } = {}) {
    if (this.spreadsheetId !== EXPECTED_SPREADSHEET_ID) throw new Error('Spreadsheet ID 不在 allowlist');
    const metadata = await this.adapter.precheck();
    if (metadata.timeZone !== 'Asia/Taipei') {
      throw new Error(`PRECHECK 失敗：Spreadsheet timezone 必須是 Asia/Taipei，實際為 ${metadata.timeZone}`);
    }
    if (this.armed) await this.adapter.verifyArmedGates({ requiredProjections: requireProjections ? ['8', '3', '6', '7'] : [], liveCell: '0_賽事設定!B12', requiredLiveValue: 0 });
    return metadata;
  }

  manifestHash(manifest) { return hash({ schema: manifest.schema, run_id: manifest.run_id, allowlist: manifest.allowlist, pre_canonical_hash: manifest.pre_canonical_hash }); }

  async snapshot(runId) {
    const refs = this.plan.flatMap((match) => match.cells);
    const pre = await this.adapter.readCells(refs);
    const manifest = {
      schema: 2, run_id: runId, spreadsheet_id: this.spreadsheetId,
      state: STATES.SNAPSHOT, reason: null, created_at: new Date().toISOString(),
      allowlist: [...new Set(refs)], pre_image: pre, pre_canonical_hash: hash(canonicalCells(pre)), post_image: {}, readback_evidence: { pre: readbackEvidence(pre), writes: {} },
      journal_hash: null, checkpoint: { completed: [], stage: 'qualification', next_segment: 1 }, plan: this.plan, lease_session: this.leaseSession()
    };
    ensureDir(this.runDir(runId));
    await this.persist(manifest);
    this.activeManifest = manifest;
    appendJournal(this.runDir(runId), { type: 'SNAPSHOT', refs: refs.length, pre_canonical_hash: manifest.pre_canonical_hash });
    return manifest;
  }

  async executeMatch(manifest, match) {
    await this.watchdog(manifest);
    if (isKillSwitchSet(this.stateDir)) throw Object.assign(new Error('Kill switch 已啟動'), { p0: true });
    if (!this.allowedStages.has(match.stage)) throw new Error(`PENDING_STAGE_GATE:${match.stage}`);
    const score = scoreFor(manifest.run_id, match.id);
    assertLegalScore(score);
    const scoreCells = match.scoreCells || match.cells;
    const post = { [scoreCells[0]]: cellForNumber(score[0]), [scoreCells[1]]: cellForNumber(score[1]) };
    // 淘汰賽：先問解析器這一場誰上場。解析器只吃「後端 O 欄算出的勝方」往下推，
    // 不用本地記的分數，所以這是真的在驗後端公式鏈，而不是自己跟自己對答案。
    if (match.nameCells) {
      if (!this.resolver) throw new Error(`RESOLVER_REQUIRED:${match.id}`);
      const names = await this.resolver.namesFor(match, this.adapter);
      if (!Array.isArray(names) || names.length !== 2 || !names.every((n) => typeof n === 'string' && n)) {
        throw Object.assign(new Error(`無法推導參賽隊伍：${match.id}（場次 ${match.no}）`), { p0: true });
      }
      post[match.nameCells[0]] = cellForString(names[0]);
      post[match.nameCells[1]] = cellForString(names[1]);
    }
    const current = await this.adapter.readCells(match.cells);
    const expectedPre = Object.fromEntries(match.cells.map((ref) => [ref, manifest.pre_image[ref]]));
    const expectedPost = Object.fromEntries(match.cells.map((ref) => [ref, post[ref]]));
    if (sameCells(current, expectedPost)) return { skipped: true, post };
    if (!sameCells(current, expectedPre)) throw Object.assign(new Error(`CAS 衝突：${match.id}`), { p0: true });
    // Persist intent before network I/O. If a process dies after an accepted
    // request but before its response, restore still knows every possible write.
    manifest.in_flight = { match: match.id, post };
    await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), { type: 'WRITE_INTENT', match: match.id });
    try {
      await this.adapter.writeCells(post);
    } catch (error) {
      if (!isTransient(error)) throw error;
      const readback = await this.adapter.readCells(match.cells);
      if (!sameCells(readback, expectedPost)) throw error;
      appendJournal(this.runDir(manifest.run_id), { type: 'WRITE_TIMEOUT_READBACK_OK', match: match.id });
    }
    const confirmed = await this.adapter.readCells(match.cells);
    if (!sameCells(confirmed, expectedPost)) throw Object.assign(new Error(`寫入 readback 不一致：${match.id}`), { p0: true });
    manifest.readback_evidence.writes[match.id] = readbackEvidence(confirmed);
    return { skipped: false, post };
  }

  async restore(manifest) {
    await this.watchdog(manifest);
    manifest.state = STATES.RESTORING;
    await this.persist(manifest);
    if (manifest.schema !== 2 || hash(canonicalCells(manifest.pre_image)) !== manifest.pre_canonical_hash || !Array.isArray(manifest.allowlist) || !manifest.allowlist.every((ref) => manifest.plan.some((m) => m.cells.includes(ref)))) throw new Error('manifest 驗證失敗');
    const possiblePost = { ...manifest.post_image, ...(manifest.in_flight?.post || {}) };
    const currentAll = await this.adapter.readCells(Object.keys(possiblePost));
    const safe = {}; const conflicts = [];
    for (const ref of Object.keys(possiblePost)) {
      await this.watchdog(manifest);
      const current = { [ref]: currentAll[ref] }, pre = { [ref]: manifest.pre_image[ref] }, post = { [ref]: possiblePost[ref] };
      if (sameCells(current, pre)) continue;
      if (sameCells(current, post)) safe[ref] = manifest.pre_image[ref]; else conflicts.push(ref);
    }
    if (Object.keys(safe).length) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.watchdog(manifest);
        try { await this.adapter.writeCells(safe); const check = await this.adapter.readCells(Object.keys(safe)); if (sameCells(check, safe)) break; if (attempt === 1) throw new Error('RESTORE_READBACK_FAILED'); }
        catch (error) { if (!isTransient(error) || attempt === 1) throw error; }
      }
    }
    if (conflicts.length) { manifest.state = STATES.MANUAL_HOLD; manifest.reason = [manifest.reason, `RESTORE_CONFLICT:${conflicts.join(',')}`].filter(Boolean).join(';'); await this.persist(manifest); appendJournal(this.runDir(manifest.run_id), { type: 'MANUAL_HOLD', conflicts }); return manifest; }
    for (const match of manifest.plan) {
      await this.watchdog(manifest);
      for (const ref of match.cells) {
        if (!(ref in possiblePost)) continue;
        const current = await this.adapter.readCells([ref]);
        const pre = { [ref]: manifest.pre_image[ref] };
        const post = { [ref]: possiblePost[ref] };
        if (sameCells(current, pre)) continue;
        if (!sameCells(current, post)) {
          manifest.state = STATES.RESTORE_FAILURE;
          manifest.reason = [manifest.reason, `RESTORE_CONFLICT:${ref}`].filter(Boolean).join(';');
          await this.persist(manifest);
          appendJournal(this.runDir(manifest.run_id), { type: 'RESTORE_CONFLICT', ref });
          return manifest;
        }
        await this.watchdog(manifest);
        await this.adapter.writeCells(pre);
        const confirmed = await this.adapter.readCells([ref]);
        if (!sameCells(confirmed, pre)) {
          manifest.state = STATES.RESTORE_FAILURE;
          manifest.reason = [manifest.reason, `RESTORE_READBACK_FAILED:${ref}`].filter(Boolean).join(';');
          await this.persist(manifest);
          return manifest;
        }
      }
    }
    manifest.state = STATES.RESTORE_VERIFY;
    const finalValues = await this.adapter.readCells(manifest.allowlist);
    if (!sameCells(finalValues, manifest.pre_image)) {
      manifest.state = STATES.RESTORE_FAILURE;
      manifest.reason = [manifest.reason, 'RESTORE_VERIFY_MISMATCH'].filter(Boolean).join(';');
    } else {
      if (this.armed) await this.adapter.verifyArmedGates({ requiredProjections: ['8', '3', '6', '7'], liveCell: '0_賽事設定!B12', requiredLiveValue: 0 });
      manifest.state = STATES.COMPLETE;
      manifest.reason = manifest.reason || 'NORMAL_RESTORED';
    }
    await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), { type: manifest.state, reason: manifest.reason });
    return manifest;
  }

  async restoreRefs(manifest, refs) {
    const possiblePost = { ...manifest.post_image, ...(manifest.in_flight?.post || {}) };
    for (const ref of refs) {
      await this.watchdog(manifest);
      const current = await this.adapter.readCells([ref]);
      const pre = { [ref]: manifest.pre_image[ref] };
      const post = { [ref]: possiblePost[ref] };
      if (sameCells(current, pre)) continue;
      if (!(ref in possiblePost) || !sameCells(current, post)) {
        throw Object.assign(new Error(`CANARY_RESTORE_CONFLICT:${ref}`), { p0: true });
      }
      await this.adapter.writeCells(pre);
      if (!sameCells(await this.adapter.readCells([ref]), pre)) {
        throw Object.assign(new Error(`CANARY_RESTORE_READBACK_FAILED:${ref}`), { p0: true });
      }
    }
  }

  observerReady() { return fs.existsSync(path.join(this.stateDir, 'OBSERVER_READY')); }
  canaryApproved() { return fs.existsSync(path.join(this.stateDir, 'CANARY_APPROVED')); }

  async waitInterval(seconds, manifest) {
    if (this.fast) return;
    let remaining = seconds * 1000;
    // A normal 20–40 s jitter must never consume a 60 s lease. Renew/check
    // before every long wait and heartbeat at most every 10 seconds.
    while (remaining > 0) {
      await this.watchdog(manifest);
      if (this.stopRequested) return;
      const slice = Math.min(1_000, remaining);
      await this.sleepFn(slice);
      remaining -= slice;
    }
  }

  async runMainPhase(manifest) {
    this.activeManifest = manifest;
    manifest.state = STATES.RUNNING;
    await this.persist(manifest);
    const intervals = pairedJitter(this.plan.length, this.random);
    let nextDue = Date.now();
    for (let i = 0; i < this.plan.length; i += 1) {
      if (this.stopRequested || (this.stopAfter !== null && i >= this.stopAfter)) {
        manifest.reason = 'MANUAL_STOP_RESTORED';
        break;
      }
      const match = this.plan[i];
      const result = await this.executeMatch(manifest, match);
      Object.assign(manifest.post_image, result.post);
      delete manifest.in_flight;
      manifest.checkpoint.completed.push(match.id);
      manifest.checkpoint.stage = match.stage;
      await this.persist(manifest);
      appendJournal(this.runDir(manifest.run_id), { type: result.skipped ? 'SKIP_ALREADY_WRITTEN' : 'WRITE_CONFIRMED', match: match.id, score: Object.values(result.post).map((v) => v.userEnteredValue.numberValue) });
      nextDue += intervals[i] * 1000;
      await this.waitInterval(Math.max(0, nextDue - this.now()) / 1000, manifest);
    }
    manifest.state = STATES.VERIFY;
    await this.persist(manifest);
    return this.restore(manifest);
  }

  segmentBounds(segment) {
    if (!Number.isInteger(segment) || segment < 1 || segment > SEGMENTS.length || this.plan.length !== 310) throw new Error('SEGMENT_INVALID');
    return SEGMENTS[segment - 1];
  }

  assertSegmentCheckpoint(manifest, segment) {
    const [start] = this.segmentBounds(segment);
    const expectedState = segment === 1 ? STATES.CANARY_WAITING_APPROVAL : STATES.SEGMENT_WAITING;
    const expected = this.plan.slice(0, start).map((match) => match.id);
    if (manifest.state !== expectedState || manifest.checkpoint?.next_segment !== segment || JSON.stringify(manifest.checkpoint?.completed || []) !== JSON.stringify(expected)) throw Object.assign(new Error('SEGMENT_ORDER_INVALID'), { code: 'SEGMENT_ORDER_INVALID' });
  }

  async runSegment(manifest, segment) {
    this.assertSegmentCheckpoint(manifest, segment);
    this.activeManifest = manifest;
    const [start, end] = this.segmentBounds(segment);
    const matches = this.plan.slice(start, end);
    manifest.state = STATES.RUNNING;
    await this.persist(manifest);
    const intervals = pairedJitter(matches.length, this.random);
    let nextDue = this.now();
    for (let i = 0; i < matches.length; i += 1) {
      if (this.stopRequested || (this.stopAfter !== null && i >= this.stopAfter)) { manifest.reason = 'MANUAL_STOP_RESTORED'; break; }
      const match = matches[i];
      const result = await this.executeMatch(manifest, match);
      Object.assign(manifest.post_image, result.post);
      delete manifest.in_flight;
      manifest.checkpoint.completed.push(match.id);
      manifest.checkpoint.stage = match.stage;
      await this.persist(manifest);
      nextDue += intervals[i] * 1000;
      await this.waitInterval(Math.max(0, nextDue - this.now()) / 1000, manifest);
    }
    if (manifest.checkpoint.completed.length !== end || manifest.reason) return this.restore(manifest);
    if (segment < SEGMENTS.length) {
      manifest.state = STATES.SEGMENT_WAITING;
      manifest.checkpoint.next_segment = segment + 1;
      await this.persist(manifest);
      appendJournal(this.runDir(manifest.run_id), { type: 'SEGMENT_WAITING', segment, next_segment: segment + 1 });
      return manifest;
    }
    manifest.state = STATES.VERIFY;
    await this.persist(manifest);
    return this.restore(manifest);
  }

  async start(runId = makeRunId()) {
    this.assertArmed();
    ensureDir(this.stateDir);
    let manifest;
    try {
      // Resume approval is deliberately checked before a Sheet lease is taken.
      if (this.resumeOnly && this.stateStore) {
        const pending = await this.stateStore.read(runId);
        const approval = await this.stateStore.read(runId, 'approval');
        const expectedState = this.segment === null || this.segment === 1 ? STATES.CANARY_WAITING_APPROVAL : STATES.SEGMENT_WAITING;
        if (pending.state !== expectedState || approval.run_id !== runId || approval.manifest_hash !== this.manifestHash(pending)) throw new Error('APPROVAL_PRELEASE_INVALID');
      }
      await this.acquireLease(runId);
      if (this.resumeOnly && this.stateStore) {
        const current = await this.stateStore.read(runId);
        const approval = await this.stateStore.read(runId, 'approval');
        const expectedState = this.segment === null || this.segment === 1 ? STATES.CANARY_WAITING_APPROVAL : STATES.SEGMENT_WAITING;
        if (current.state !== expectedState || approval.run_id !== runId || approval.manifest_hash !== this.manifestHash(current)) throw Object.assign(new Error('APPROVAL_TOCTOU_INVALID'), { p0: true });
        manifest = current;
      }
      let hasManifest = fs.existsSync(this.manifestPath(runId));
      if (!hasManifest && this.stateStore) {
        try { manifest = await this.stateStore.read(runId); hasManifest = true; }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (hasManifest) {
        manifest ||= readJson(this.manifestPath(runId));
        ensureDir(this.runDir(runId));
        this.save(manifest);
        if (this.canaryOnly) throw new Error('CANARY_ONLY_EXISTING_MANIFEST_REJECTED');
        if (this.segment !== null) {
          await this.precheck({ requireProjections: this.segment === 1 });
          return await this.runSegment(manifest, this.segment);
        }
        if (manifest.state !== STATES.CANARY_WAITING_APPROVAL) throw new Error(`不可續跑的 state：${manifest.state}`);
        await this.precheck();
        if (this.mode === 'dry-run') { if (!this.canaryApproved()) return manifest; }
        appendJournal(this.runDir(runId), { type: 'CANARY_APPROVED', fencing_token: this.leaseHandle.fencingToken });
        return await this.runMainPhase(manifest);
      }
      if (this.resumeOnly) throw new Error('RESUME_ONLY_MANIFEST_REQUIRED');
      const metadata = await this.precheck();
      if (this.mode === 'dry-run' && !this.observerReady()) throw new Error('PRECHECK 失敗：Browser observer readiness 未確認（缺少 OBSERVER_READY）');
      manifest = await this.snapshot(runId);
      manifest.state = STATES.CANARY;
      manifest.precheck = metadata;
      await this.persist(manifest);
      const canary = this.plan.slice(0, Math.min(3, this.plan.length));
      const canaryIntervals = pairedJitter(canary.length, this.random);
      for (const match of canary) {
        if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
        const result = await this.executeMatch(manifest, match);
        Object.assign(manifest.post_image, result.post);
        delete manifest.in_flight;
        await this.persist(manifest);
        await this.waitInterval(canaryIntervals[canary.indexOf(match)], manifest);
      }
      if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
      const canaryRefs = canary.flatMap((match) => match.cells);
      await this.restoreRefs(manifest, canaryRefs);
      canaryRefs.forEach((ref) => delete manifest.post_image[ref]);
      if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
      appendJournal(this.runDir(runId), { type: 'CANARY_RESTORED', matches: canary.map((match) => match.id) });
      manifest.state = STATES.CANARY_WAITING_APPROVAL;
      await this.persist(manifest);
      if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
      if (this.stateStore && this.mode !== 'dry-run') await this.stateStore.writeCanaryReport(manifest, this.leaseHandle, this.manifestHash(manifest));
      if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
      return manifest;
    } catch (error) {
      if (error.code === 'SEGMENT_ORDER_INVALID' || error.code === 'APPROVAL_PRELEASE_INVALID') throw error;
      if (!manifest) throw error;
      const detail = safeError(error);
      manifest.reason = error.p0 ? `P0_ABORT:${detail}` : `ABORT:${detail}`;
      appendJournal(this.runDir(runId), { type: error.p0 ? 'P0_ABORT' : 'ABORT', message: detail });
      return this.restore(manifest);
    } finally {
      if (this.leaseHandle) {
        try { await this.lease.release(this.leaseHandle); }
        catch (error) { appendJournal(this.runDir(runId), { type: 'LEASE_RELEASE_FAILED', message: safeError(error) }); }
      }
    }
  }

  async restoreOnly(runId) {
    this.assertArmed();
    let acquired = false; let lastError;
    for (let attempt = 0; attempt < 19; attempt += 1) {
      try { await this.acquireLease(runId); acquired = true; break; }
      catch (error) { lastError = error; if (error.code !== 'LEASE_BUSY') throw error; if (attempt < 18) await this.sleepFn(5_000); }
    }
    if (!acquired) throw lastError;
    try {
      let manifest;
      try { manifest = this.stateStore ? await this.stateStore.read(runId) : readJson(this.manifestPath(runId)); }
      catch (error) {
        if (error.status === 404 || error.code === 'ENOENT') return { run_id: runId, state: STATES.COMPLETE, reason: 'NO_MANIFEST_NO_WRITES' };
        throw error;
      }
      this.activeManifest = manifest;
      if (manifest.spreadsheet_id !== this.spreadsheetId) throw new Error('manifest spreadsheet 不符');
      manifest.lease_session = this.leaseSession();
      await this.persist(manifest);
      await this.precheck({ requireProjections: false });
      return await this.restore(manifest);
    } finally {
      try { await this.lease.release(this.leaseHandle); }
      catch (error) { appendJournal(this.runDir(runId), { type: 'LEASE_RELEASE_FAILED', message: safeError(error) }); }
    }
  }

  async requestCancel() {
    this.stopRequested = true;
    if (!this.activeManifest) return;
    this.activeManifest.state = STATES.CANCELLED_RESTORE_REQUIRED;
    this.activeManifest.reason = 'CANCELLED_RESTORE_REQUIRED';
    try { await this.persist(this.activeManifest); appendJournal(this.runDir(this.activeManifest.run_id), { type: 'CANCEL_INTENT' }); }
    catch { /* signal handler must not mask the eventual fail-closed exit */ }
  }
}

function parseArgs(argv) {
  const [mode = 'dry-run', ...rest] = argv;
  const options = { mode, armed: false, fast: false, expectCanary: false, canaryOnly: false, resumeOnly: false, segment: null, stateDir: path.join(__dirname, 'runs'), runId: null, localState: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--armed') options.armed = true;
    else if (arg === '--local-state') options.localState = true;
    else if (arg === '--fast') options.fast = true;
    else if (arg === '--expect-canary') options.expectCanary = true;
    else if (arg === '--canary-only') options.canaryOnly = true;
    else if (arg === '--resume-only') options.resumeOnly = true;
    else if (arg === '--segment') options.segment = Number(rest[++i]);
    else if (arg === '--state-dir') options.stateDir = rest[++i];
    else if (arg === '--run-id') options.runId = rest[++i];
    else throw new Error(`未知參數：${arg}`);
  }
  if (!['dry-run', 'ci-dry-run', 'run', 'restore-only'].includes(mode)) throw new Error('mode 必須為 dry-run、ci-dry-run、run 或 restore-only');
  if (options.armed && options.fast) throw new Error('--fast 與 --armed 不可同時使用');
  if (options.canaryOnly && options.resumeOnly) throw new Error('--canary-only 與 --resume-only 不可同時使用');
  if (options.segment !== null && (!Number.isInteger(options.segment) || options.segment < 1 || options.segment > 5)) throw new Error('--segment 必須為 1 至 5');
  return options;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'ci-dry-run') {
    const phase = { name: 'all', matches: fullPlan() };
    // No adapter, credential, GCS client or lease is ever
    // constructed in this dedicated CI validation mode.
    console.log(JSON.stringify({ state: STATES.COMPLETE, outcome: 'NORMAL_RESTORED', dry_run: true, phase: phase.name, matches: phase.matches.length }, null, 2));
    return;
  }
  const spreadsheetId = opts.mode === 'dry-run' ? (process.env.SOLAR_CUP_SPREADSHEET_ID || EXPECTED_SPREADSHEET_ID) : process.env.SOLAR_CUP_SPREADSHEET_ID;
  if (opts.mode !== 'dry-run' && !spreadsheetId) throw new Error('armed 模式必須明確指定 SOLAR_CUP_SPREADSHEET_ID');
  // --local-state：GCS bucket 綁的是 WIF service account，那把鑰匙只發給 GitHub Actions，
  // 本機拿不到。單一操作者、全程有人看著的演練用本機 lease／state 就夠——
  // snapshot、CAS、readback、三方復原、KILL_SWITCH 一項不減，只少了跨機器協調。
  const accessToken = opts.localState && !process.env.GOOGLE_ACCESS_TOKEN
    ? (await require('./sa-token').accessToken()).token
    : process.env.GOOGLE_ACCESS_TOKEN;
  let lease; let stateStore;
  const adapter = opts.mode === 'dry-run'
    ? new MockAdapter()
    : new SheetsRestAdapter({ spreadsheetId, accessToken, projectionBaselines: process.env.SOLAR_CUP_PROJECTION_BASELINES ? parseProjectionBaselines(process.env.SOLAR_CUP_PROJECTION_BASELINES) : null });
  if (opts.mode !== 'dry-run' && opts.localState) {
    lease = new LocalGenerationLease({ file: path.join(opts.stateDir, 'lease.json') });
    stateStore = new LocalRunState({ dir: opts.stateDir, lease });
  } else if (opts.mode !== 'dry-run') { const client = new GcsJsonClient({ accessToken }); lease = new GcsGenerationLease({ client, bucket: process.env.SOLAR_CUP_GCS_BUCKET, object: process.env.SOLAR_CUP_GCS_LEASE_OBJECT || 'solarcup-simulation/lease.json' }); stateStore = new GcsRunState({ client, bucket: process.env.SOLAR_CUP_GCS_BUCKET, prefix: process.env.SOLAR_CUP_GCS_STATE_PREFIX || 'solarcup-simulation/runs', lease }); }
  // 淘汰賽隊名解析：armed 走雲端逐場回讀（用後端 O 欄的勝方往下推）；
  // dry-run 背後是 mock，沒有公式引擎可讀，只用劇本填佔位名，
  // 目的是驗寫入／snapshot／restore 的機制，不宣稱驗晉級推導。
  const findings = [];
  const resolver = opts.mode === 'dry-run'
    ? new ScriptedResolver()
    : new KnockoutResolver({ source: new CloudSource(adapter), onFinding: (f) => { findings.push(f); console.warn(`[FINDING] ${f.code} ${f.detail}`); } });
  const runner = new SimulationRunner({ ...opts, adapter, spreadsheetId, lease, stateStore, resolver, plan: fullPlan(), allowedStages: ['qualification', 'knockout', 'invitational'] });
  process.on('SIGINT', () => { void runner.requestCancel(); });
  process.on('SIGTERM', () => { void runner.requestCancel(); });
  const result = opts.mode === 'restore-only' ? await runner.restoreOnly(opts.runId) : await runner.start(opts.runId || undefined);
  const outcome = result.state === STATES.MANUAL_HOLD ? 'MANUAL_HOLD'
    : result.state === STATES.SEGMENT_WAITING ? 'SEGMENT_WAITING'
    // 等待核准是正常的中間狀態，不是失敗；標成 RESTORE_FAILURE 會讓人以為復原出事
    : result.state === STATES.CANARY_WAITING_APPROVAL ? 'CANARY_WAITING_APPROVAL'
    : result.state !== STATES.COMPLETE ? 'RESTORE_FAILURE'
      : result.reason === 'NORMAL_RESTORED' ? 'NORMAL_RESTORED'
        : result.reason === 'MANUAL_STOP_RESTORED' ? 'MANUAL_STOP_RESTORED'
          : result.reason?.startsWith('P0_ABORT:') ? 'P0_ABORT_RESTORED' : 'ABORT_RESTORED';
  console.log(JSON.stringify({ run_id: result.run_id, state: result.state, outcome, reason: result.reason }, null, 2));
  process.exitCode = outcome === 'NORMAL_RESTORED' || outcome === 'SEGMENT_WAITING' || (opts.expectCanary && result.state === STATES.CANARY_WAITING_APPROVAL) ? 0 : 2;
}

if (require.main === module) main().catch((error) => { console.error(safeError(error)); process.exitCode = 2; });

module.exports = { SimulationRunner, EXPECTED_SPREADSHEET_ID, cellForNumber, parseArgs, parseProjectionBaselines, InMemoryLease };
