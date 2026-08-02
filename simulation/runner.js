#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  STATES, hash, same, sameCells, canonicalCells, readbackEvidence, makeRunId, scoreFor, assertLegalScore, pairedJitter,
  ensureDir, writeJson, readJson, appendJournal, defaultPlan, isKillSwitchSet
} = require('./lib');
const { MockAdapter } = require('./mock-adapter');
const { SheetsRestAdapter } = require('./sheets-rest-adapter');

const EXPECTED_SPREADSHEET_ID = '1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
const RUN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{1,80}$/;

function cellForNumber(number) { return { userEnteredValue: { numberValue: number } }; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isTransient(error) { return ['ETIMEDOUT', 'ECONNRESET'].includes(error.code) || error.status === 429 || error.status >= 500; }

class InMemoryLease {
  constructor() { this.persistent = false; }
  async acquire() { return { fencingToken: `local-${Date.now()}` }; }
  async assertHeld() { return true; }
  async release() { return true; }
}

class SimulationRunner {
  constructor({ adapter, stateDir, mode = 'dry-run', armed = false, spreadsheetId, plan = defaultPlan(), fast = false, stopAfter = null, random = Math.random, allowedStages = ['qualification'], lease = new InMemoryLease(), sleepFn = sleep, markerWaitMs = 90_000 }) {
    this.adapter = adapter;
    this.stateDir = stateDir;
    this.mode = mode;
    this.armed = armed;
    this.spreadsheetId = spreadsheetId;
    this.plan = plan;
    this.fast = fast;
    this.stopAfter = stopAfter;
    this.random = random;
    this.allowedStages = new Set(allowedStages);
    this.lease = lease;
    this.sleepFn = sleepFn;
    this.markerWaitMs = markerWaitMs;
    this.leaseHandle = null;
    this.stopRequested = false;
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

  async watchdog() {
    if (!this.leaseHandle && this.mode === 'dry-run') return true;
    if (!this.leaseHandle) throw Object.assign(new Error('lease 不存在'), { p0: true });
    await this.lease.assertHeld(this.leaseHandle);
  }

  runDir(runId) { if (!RUN_ID.test(runId)) throw new Error('非法 run_id'); return path.join(this.stateDir, runId); }
  manifestPath(runId) { return path.join(this.runDir(runId), 'manifest.json'); }
  save(manifest) { writeJson(this.manifestPath(manifest.run_id), manifest); }

  async precheck() {
    if (this.spreadsheetId !== EXPECTED_SPREADSHEET_ID) throw new Error('Spreadsheet ID 不在 allowlist');
    const metadata = await this.adapter.precheck();
    if (metadata.timeZone !== 'Asia/Taipei') {
      throw new Error(`PRECHECK 失敗：Spreadsheet timezone 必須是 Asia/Taipei，實際為 ${metadata.timeZone}`);
    }
    if (this.armed) await this.adapter.verifyArmedGates({ requiredProjections: ['8', '3', '6', '7'], liveCell: '0_賽事設定!B12', requiredLiveValue: 0 });
    return metadata;
  }

  manifestHash(manifest) { return hash({ schema: manifest.schema, run_id: manifest.run_id, allowlist: manifest.allowlist, pre_canonical_hash: manifest.pre_canonical_hash }); }
  markerPath(runId, name) { return path.join(this.stateDir, 'markers', `${runId}.${name}.json`); }
  requireMarker(manifest, name) {
    const marker = readJson(this.markerPath(manifest.run_id, name));
    if (marker.run_id !== manifest.run_id || marker.fencing_token !== this.leaseHandle?.fencingToken || marker.manifest_hash !== this.manifestHash(manifest) || Date.parse(marker.expires_at) <= Date.now()) throw new Error(`MARKER_INVALID:${name}`);
    return marker;
  }
  assertObserverAlive(manifest) { if (this.mode === 'dry-run') return true; this.requireMarker(manifest, 'observer-heartbeat'); }

  async waitForRunScopedMarkers(manifest) {
    const deadline = Date.now() + this.markerWaitMs;
    while (Date.now() < deadline) {
      try { this.requireMarker(manifest, 'canary-observed'); this.requireMarker(manifest, 'canary-approved'); return; }
      catch (error) { if (!String(error.message).startsWith('MARKER_INVALID:')) throw error; }
      await this.sleepFn(1_000);
    }
    throw new Error('MARKER_WAIT_TIMEOUT');
  }

  async snapshot(runId) {
    const refs = this.plan.flatMap((match) => match.cells);
    const pre = await this.adapter.readCells(refs);
    const manifest = {
      schema: 2, run_id: runId, spreadsheet_id: this.spreadsheetId,
      state: STATES.SNAPSHOT, reason: null, created_at: new Date().toISOString(),
      allowlist: [...new Set(refs)], pre_image: pre, pre_canonical_hash: hash(canonicalCells(pre)), post_image: {}, readback_evidence: { pre: readbackEvidence(pre), writes: {} },
      journal_hash: null, checkpoint: { completed: [], stage: 'qualification' }, plan: this.plan
    };
    ensureDir(this.runDir(runId));
    this.save(manifest);
    appendJournal(this.runDir(runId), { type: 'SNAPSHOT', refs: refs.length, pre_canonical_hash: manifest.pre_canonical_hash });
    return manifest;
  }

  async executeMatch(manifest, match) {
    await this.watchdog();
    this.assertObserverAlive(manifest);
    if (isKillSwitchSet(this.stateDir)) throw Object.assign(new Error('Kill switch 已啟動'), { p0: true });
    if (!this.allowedStages.has(match.stage)) throw new Error(`PENDING_STAGE_GATE:${match.stage}`);
    const score = scoreFor(manifest.run_id, match.id);
    assertLegalScore(score);
    const post = { [match.cells[0]]: cellForNumber(score[0]), [match.cells[1]]: cellForNumber(score[1]) };
    const current = await this.adapter.readCells(match.cells);
    const expectedPre = Object.fromEntries(match.cells.map((ref) => [ref, manifest.pre_image[ref]]));
    const expectedPost = Object.fromEntries(match.cells.map((ref) => [ref, post[ref]]));
    if (sameCells(current, expectedPost)) return { skipped: true, post };
    if (!sameCells(current, expectedPre)) throw Object.assign(new Error(`CAS 衝突：${match.id}`), { p0: true });
    // Persist intent before network I/O. If a process dies after an accepted
    // request but before its response, restore still knows every possible write.
    manifest.in_flight = { match: match.id, post };
    this.save(manifest);
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
    await this.watchdog();
    manifest.state = STATES.RESTORING;
    this.save(manifest);
    if (manifest.schema !== 2 || hash(canonicalCells(manifest.pre_image)) !== manifest.pre_canonical_hash || !Array.isArray(manifest.allowlist) || !manifest.allowlist.every((ref) => manifest.plan.some((m) => m.cells.includes(ref)))) throw new Error('manifest 驗證失敗');
    const possiblePost = { ...manifest.post_image, ...(manifest.in_flight?.post || {}) };
    const currentAll = await this.adapter.readCells(Object.keys(possiblePost));
    const safe = {}; const conflicts = [];
    for (const ref of Object.keys(possiblePost)) {
      const current = { [ref]: currentAll[ref] }, pre = { [ref]: manifest.pre_image[ref] }, post = { [ref]: possiblePost[ref] };
      if (sameCells(current, pre)) continue;
      if (sameCells(current, post)) safe[ref] = manifest.pre_image[ref]; else conflicts.push(ref);
    }
    if (Object.keys(safe).length) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { await this.adapter.writeCells(safe); const check = await this.adapter.readCells(Object.keys(safe)); if (sameCells(check, safe)) break; if (attempt === 1) throw new Error('RESTORE_READBACK_FAILED'); }
        catch (error) { if (!isTransient(error) || attempt === 1) throw error; }
      }
    }
    if (conflicts.length) { manifest.state = STATES.MANUAL_HOLD; manifest.reason = [manifest.reason, `RESTORE_CONFLICT:${conflicts.join(',')}`].filter(Boolean).join(';'); this.save(manifest); appendJournal(this.runDir(manifest.run_id), { type: 'MANUAL_HOLD', conflicts }); return manifest; }
    for (const match of manifest.plan) {
      for (const ref of match.cells) {
        if (!(ref in possiblePost)) continue;
        const current = await this.adapter.readCells([ref]);
        const pre = { [ref]: manifest.pre_image[ref] };
        const post = { [ref]: possiblePost[ref] };
        if (sameCells(current, pre)) continue;
        if (!sameCells(current, post)) {
          manifest.state = STATES.RESTORE_FAILURE;
          manifest.reason = [manifest.reason, `RESTORE_CONFLICT:${ref}`].filter(Boolean).join(';');
          this.save(manifest);
          appendJournal(this.runDir(manifest.run_id), { type: 'RESTORE_CONFLICT', ref });
          return manifest;
        }
        await this.adapter.writeCells(pre);
        const confirmed = await this.adapter.readCells([ref]);
        if (!sameCells(confirmed, pre)) {
          manifest.state = STATES.RESTORE_FAILURE;
          manifest.reason = [manifest.reason, `RESTORE_READBACK_FAILED:${ref}`].filter(Boolean).join(';');
          this.save(manifest);
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
      manifest.state = STATES.COMPLETE;
      manifest.reason = manifest.reason || 'NORMAL_RESTORED';
    }
    this.save(manifest);
    appendJournal(this.runDir(manifest.run_id), { type: manifest.state, reason: manifest.reason });
    return manifest;
  }

  async restoreRefs(manifest, refs) {
    const possiblePost = { ...manifest.post_image, ...(manifest.in_flight?.post || {}) };
    for (const ref of refs) {
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

  async waitInterval(seconds) {
    if (!this.fast) await this.sleepFn(seconds * 1000);
  }

  async runMainPhase(manifest) {
    manifest.state = STATES.RUNNING;
    this.save(manifest);
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
      this.save(manifest);
      appendJournal(this.runDir(manifest.run_id), { type: result.skipped ? 'SKIP_ALREADY_WRITTEN' : 'WRITE_CONFIRMED', match: match.id, score: Object.values(result.post).map((v) => v.userEnteredValue.numberValue) });
      nextDue += intervals[i] * 1000;
      if (!this.fast) await this.sleepFn(Math.max(0, nextDue - Date.now()));
    }
    manifest.state = STATES.VERIFY;
    this.save(manifest);
    return this.restore(manifest);
  }

  async start(runId = makeRunId()) {
    this.assertArmed();
    ensureDir(this.stateDir);
    let manifest;
    try {
      await this.acquireLease(runId);
      if (fs.existsSync(this.manifestPath(runId))) {
        manifest = readJson(this.manifestPath(runId));
        if (manifest.state !== STATES.CANARY_WAITING_APPROVAL) throw new Error(`不可續跑的 state：${manifest.state}`);
        await this.precheck();
        if (this.mode === 'dry-run') { if (!this.canaryApproved()) return manifest; }
        else {
          // The resumed process holds its newly acquired lease while Browser
          // writes markers carrying this exact token. It never accepts markers
          // made for the released canary lease.
          manifest.state = STATES.WAITING_MARKERS;
          manifest.resume = { fencing_token: this.leaseHandle.fencingToken, manifest_hash: this.manifestHash(manifest), waiting_until: new Date(Date.now() + this.markerWaitMs).toISOString() };
          this.save(manifest);
          appendJournal(this.runDir(runId), { type: 'WAITING_MARKERS', ...manifest.resume });
          await this.waitForRunScopedMarkers(manifest);
        }
        appendJournal(this.runDir(runId), { type: 'CANARY_APPROVED', fencing_token: this.leaseHandle.fencingToken });
        return await this.runMainPhase(manifest);
      }
      const metadata = await this.precheck();
      if (this.mode === 'dry-run' && !this.observerReady()) throw new Error('PRECHECK 失敗：Browser observer readiness 未確認（缺少 OBSERVER_READY）');
      manifest = await this.snapshot(runId);
      manifest.state = STATES.CANARY;
      manifest.precheck = metadata;
      this.save(manifest);
      const canary = this.plan.slice(0, Math.min(3, this.plan.length));
      const canaryIntervals = pairedJitter(canary.length, this.random);
      for (const match of canary) {
        const result = await this.executeMatch(manifest, match);
        Object.assign(manifest.post_image, result.post);
        delete manifest.in_flight;
        this.save(manifest);
        await this.waitInterval(canaryIntervals[canary.indexOf(match)]);
      }
      const canaryRefs = canary.flatMap((match) => match.cells);
      await this.restoreRefs(manifest, canaryRefs);
      canaryRefs.forEach((ref) => delete manifest.post_image[ref]);
      appendJournal(this.runDir(runId), { type: 'CANARY_RESTORED', matches: canary.map((match) => match.id) });
      manifest.state = STATES.CANARY_WAITING_APPROVAL;
      this.save(manifest);
      return manifest;
    } catch (error) {
      if (!manifest) throw error;
      manifest.reason = error.p0 ? `P0_ABORT:${error.message}` : `ABORT:${error.message}`;
      appendJournal(this.runDir(runId), { type: error.p0 ? 'P0_ABORT' : 'ABORT', message: error.message });
      return this.restore(manifest);
    } finally {
      if (this.leaseHandle) await this.lease.release(this.leaseHandle);
    }
  }

  async restoreOnly(runId) {
    this.assertArmed();
    await this.acquireLease(runId);
    await this.precheck();
    const manifest = readJson(this.manifestPath(runId));
    if (manifest.spreadsheet_id !== this.spreadsheetId) throw new Error('manifest spreadsheet 不符');
    try { return await this.restore(manifest); }
    finally { await this.lease.release(this.leaseHandle); }
  }
}

function parseArgs(argv) {
  const [mode = 'dry-run', ...rest] = argv;
  const options = { mode, armed: false, fast: false, stateDir: path.join(__dirname, 'runs'), runId: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--armed') options.armed = true;
    else if (arg === '--fast') options.fast = true;
    else if (arg === '--state-dir') options.stateDir = rest[++i];
    else if (arg === '--run-id') options.runId = rest[++i];
    else throw new Error(`未知參數：${arg}`);
  }
  if (!['dry-run', 'run', 'restore-only'].includes(mode)) throw new Error('mode 必須為 dry-run、run 或 restore-only');
  if (options.armed && options.fast) throw new Error('--fast 與 --armed 不可同時使用');
  return options;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const spreadsheetId = process.env.SOLAR_CUP_SPREADSHEET_ID || EXPECTED_SPREADSHEET_ID;
  const adapter = opts.mode === 'dry-run'
    ? new MockAdapter()
    : new SheetsRestAdapter({ spreadsheetId, allowSpreadsheetId: EXPECTED_SPREADSHEET_ID, accessToken: process.env.GOOGLE_ACCESS_TOKEN });
  const runner = new SimulationRunner({ ...opts, adapter, spreadsheetId });
  process.on('SIGINT', () => { runner.stopRequested = true; });
  process.on('SIGTERM', () => { runner.stopRequested = true; });
  const result = opts.mode === 'restore-only' ? await runner.restoreOnly(opts.runId) : await runner.start(opts.runId || undefined);
  const outcome = result.state === STATES.MANUAL_HOLD ? 'MANUAL_HOLD'
    : result.state !== STATES.COMPLETE ? 'RESTORE_FAILURE'
      : result.reason === 'NORMAL_RESTORED' ? 'NORMAL_RESTORED'
        : result.reason === 'MANUAL_STOP_RESTORED' ? 'MANUAL_STOP_RESTORED'
          : result.reason?.startsWith('P0_ABORT:') ? 'P0_ABORT_RESTORED' : 'ABORT_RESTORED';
  console.log(JSON.stringify({ run_id: result.run_id, state: result.state, outcome, reason: result.reason }, null, 2));
  process.exitCode = ['NORMAL_RESTORED', 'MANUAL_STOP_RESTORED', 'ABORT_RESTORED', 'P0_ABORT_RESTORED'].includes(outcome) ? 0 : 2;
}

if (require.main === module) main().catch((error) => { console.error(String(error.message).replace(/Bearer\s+[^\s]+|[A-Za-z0-9_-]{20,}/g, '[REDACTED]')); process.exitCode = 2; });

module.exports = { SimulationRunner, EXPECTED_SPREADSHEET_ID, cellForNumber, parseArgs, InMemoryLease };
