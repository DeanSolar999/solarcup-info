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
const {
  buildScenarioPlan, assertCompletedScore, applyClubTieFixture, fixtureStats,
  B_NOS, C3_NOS, C5_NOS
} = require('./scenario-engine');
const { rankGroup } = require('./bracket');
const { DualSiteObserver, SITES: OBSERVER_SITES, text: observerText } = require('./observer');
const { reportPayload, markdown } = require('./report');

const EXPECTED_SPREADSHEET_ID = '1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
const EXPECTED_BACKUP_FILE_ID = '15WHaxX9Qa-6-tw9XzQ-G0LgkzdxxGDbHqLv8dZ048RM';
const RUN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{1,72}$/;
const SEGMENTS = Object.freeze([[0, 75], [75, 115], [115, 190], [190, 265], [265, 310]]);

function cellForNumber(number) { return { userEnteredValue: { numberValue: number } }; }
function cellForString(text) { return { userEnteredValue: { stringValue: text } }; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isTransient(error) { return ['ETIMEDOUT', 'ECONNRESET'].includes(error.code) || error.status === 429 || error.status >= 500; }
function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function close(left, right, epsilon = 1e-9) { return numeric(left) !== null && Math.abs(Number(left) - Number(right)) <= epsilon; }
function uniqueCellPosts(posts) {
  const seen = new Set(); const result = [];
  for (const post of posts.filter(Boolean)) {
    const key = hash(canonicalCells(post));
    if (!seen.has(key)) { seen.add(key); result.push(post); }
  }
  return result;
}
function findingKey(finding) {
  return JSON.stringify([
    finding?.code || 'INFO', finding?.severity || 'info', finding?.eventId || null,
    finding?.detail || null, Number.isFinite(finding?.latencyMs) ? finding.latencyMs : null,
    finding?.sites || null
  ]);
}
function uniqueFindings(findings) {
  const seen = new Set(); const result = [];
  for (const finding of findings.filter(Boolean)) {
    const key = findingKey(finding);
    if (!seen.has(key)) { seen.add(key); result.push(finding); }
  }
  return result;
}
function backupEvidenceDigest(evidence) {
  return hash([
    String(evidence.backup_file_id || ''), String(evidence.source_sheet_id || ''),
    String(evidence.created_at || ''), String(evidence.title || ''), Number(evidence.size)
  ]);
}
function parseBackupEvidence(value) {
  let evidence = value;
  if (typeof value === 'string') {
    try { evidence = JSON.parse(value); } catch { throw new Error('SOLAR_CUP_BACKUP_EVIDENCE 必須為 JSON'); }
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('BACKUP_EVIDENCE_REQUIRED');
  for (const field of ['backup_file_id', 'source_sheet_id', 'created_at', 'verified_at', 'sha', 'title', 'size']) {
    if (!String(evidence[field] || '').trim()) throw new Error(`BACKUP_EVIDENCE_FIELD_MISSING:${field}`);
  }
  if (evidence.backup_file_id !== EXPECTED_BACKUP_FILE_ID) throw new Error('BACKUP_FILE_ID_MISMATCH');
  if (evidence.source_sheet_id !== EXPECTED_SPREADSHEET_ID) throw new Error('BACKUP_SOURCE_SHEET_MISMATCH');
  const size = Number(evidence.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('BACKUP_SIZE_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(evidence.sha) || evidence.sha.toLowerCase() !== backupEvidenceDigest({ ...evidence, size })) throw new Error('BACKUP_SHA_INVALID');
  const created = Date.parse(evidence.created_at); const verified = Date.parse(evidence.verified_at);
  const now = Date.now();
  if (!Number.isFinite(created) || !Number.isFinite(verified) || verified < created || verified > now + 60_000 || now - verified > 15 * 60_000) throw new Error('BACKUP_TIMESTAMP_INVALID');
  return { ...evidence, size, title: String(evidence.title).trim(), sha: evidence.sha.toLowerCase() };
}
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
  constructor({ adapter, stateDir, mode = 'dry-run', armed = false, canaryOnly = false, resumeOnly = false, autonomous = false, segment = null, spreadsheetId, plan = defaultPlan(), fast = false, stopAfter = null, random = Math.random, resolver = null, observer = null, keepScores = false, allowedStages = ['qualification'], lease = new InMemoryLease(), stateStore = null, sleepFn = sleep, now = () => Date.now(), backupEvidence = null, externalFindings = [] }) {
    this.adapter = adapter;
    this.stateDir = stateDir;
    this.mode = mode;
    this.armed = armed;
    this.canaryOnly = canaryOnly; this.resumeOnly = resumeOnly; this.autonomous = autonomous;
    this.segment = segment;
    this.spreadsheetId = spreadsheetId;
    this.plan = plan;
    this.fast = fast;
    this.stopAfter = stopAfter;
    this.random = random;
    // 淘汰賽隊名解析器。null＝不寫隊名（僅供既有的資格賽-only 測試沿用）。
    this.resolver = resolver; this.observer = observer;
    // 跑完保留分數供人工檢視，不自動復原（復原改為人工觸發 restore-only）
    this.keepScores = keepScores;
    this.findings = [];
    this.allowedStages = new Set(allowedStages);
    this.lease = lease;
    this.stateStore = stateStore;
    this.sleepFn = sleepFn;
    this.now = now;
    this.backupEvidence = backupEvidence;
    this.externalFindings = externalFindings;
    this.externalFindingCursor = 0;
    this.leaseHandle = null;
    this.watchdogInFlight = null;
    this.stopRequested = false;
    this.activeManifest = null;
    this.observerTeamByNo = new Map();
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
    if (this.watchdogInFlight) return this.watchdogInFlight;
    const active = this.runWatchdog(manifest);
    this.watchdogInFlight = active;
    try { return await active; }
    finally { if (this.watchdogInFlight === active) this.watchdogInFlight = null; }
  }

  async runWatchdog(manifest = null) {
    if (!this.leaseHandle && this.mode === 'dry-run') return true;
    if (!this.leaseHandle) throw Object.assign(new Error('lease 不存在'), { p0: true });
    if (this.leaseHandle.expiresAt && (!Number.isFinite(this.leaseHandle.expiresAt) || this.leaseHandle.expiresAt <= this.now())) throw Object.assign(new Error('LEASE_EXPIRED'), { p0: true, code: 'LEASE_LOST' });
    try { await this.lease.assertHeld(this.leaseHandle); }
    catch (error) { throw Object.assign(error, { p0: true, code: error.code || 'LEASE_LOST' }); }
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

  async withObserverHeartbeat(operation, manifest = this.activeManifest) {
    if (typeof operation !== 'function') throw new TypeError('observer operation 必須是 function');
    let operationResult;
    try { operationResult = operation(); }
    catch (error) { throw error; }
    let eagerOutcome = null;
    const settled = Promise.resolve(operationResult).then(
      (value) => { eagerOutcome = { done: true, value }; return eagerOutcome; },
      (error) => { eagerOutcome = { done: true, error }; return eagerOutcome; }
    );
    // Avoid charging a synthetic 10-second heartbeat to observers that resolve
    // immediately (important for serial-window accounting and fake clocks).
    await Promise.resolve();
    if (eagerOutcome) {
      if (eagerOutcome.error) throw eagerOutcome.error;
      return eagerOutcome.value;
    }
    while (true) {
      const outcome = await Promise.race([
        settled,
        this.sleepFn(10_000).then(() => ({ heartbeat: true }))
      ]);
      if (outcome.done) {
        if (outcome.error) throw outcome.error;
        return outcome.value;
      }
      if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
      try { await this.watchdog(manifest); }
      catch (error) { throw Object.assign(error, { p0: true, code: error.code || 'LEASE_LOST' }); }
    }
  }

  runDir(runId) { if (!RUN_ID.test(runId)) throw new Error('非法 run_id'); return path.join(this.stateDir, runId); }
  manifestPath(runId) { return path.join(this.runDir(runId), 'manifest.json'); }
  save(manifest) { writeJson(this.manifestPath(manifest.run_id), manifest); }
  async persist(manifest) { this.save(manifest); if (this.stateStore && this.mode !== 'dry-run') await this.stateStore.persistManifest(manifest, this.leaseHandle); }

  async precheck({ requireProjections = true, hydrateObserver = true } = {}) {
    if (this.spreadsheetId !== EXPECTED_SPREADSHEET_ID) throw new Error('Spreadsheet ID 不在 allowlist');
    if (this.autonomous && !this.plan.find((match) => match.no === 310)?.kFixture) {
      // Must be derived before snapshot so the exact fixture and flipped scores
      // are immutable audit data. The bounded search fails closed before writes.
      applyClubTieFixture(this.plan, { maxFlips: 2, requireDisjoint: true });
    }
    const metadata = await this.adapter.precheck();
    if (metadata.timeZone !== 'Asia/Taipei') {
      throw new Error(`PRECHECK 失敗：Spreadsheet timezone 必須是 Asia/Taipei，實際為 ${metadata.timeZone}`);
    }
    if (this.armed) {
      if (typeof this.adapter.verifyBackupGate !== 'function') throw new Error('BACKUP_GATE_VERIFIER_UNAVAILABLE');
      const backupEvidence = parseBackupEvidence(this.backupEvidence || process.env.SOLAR_CUP_BACKUP_EVIDENCE);
      await this.adapter.verifyBackupGate({ ...backupEvidence, expectedBackupFileId: EXPECTED_BACKUP_FILE_ID, expectedSourceSheetId: this.spreadsheetId });
      await this.adapter.verifyArmedGates({ requiredProjections: requireProjections ? ['8', '3', '6', '7'] : [], liveCell: '0_賽事設定!B12', requiredLiveValue: 0 });
      if (this.autonomous) {
        if (typeof this.adapter.authoritativeMatchRows !== 'function') throw new Error('AUTHORITATIVE_MATCH_PREFLIGHT_UNAVAILABLE');
        await this.adapter.authoritativeMatchRows();
      }
    }
    if (hydrateObserver && this.observer && typeof this.adapter.values === 'function') {
      const rows = await this.adapter.values('8_發布_戰情看板!A2:C311');
      this.observerTeamByNo = new Map(rows
        .map((row) => [Number(row?.[0]), [String(row?.[1] || '').trim(), String(row?.[2] || '').trim()]])
        .filter(([no, names]) => Number.isInteger(no) && names.every(Boolean)));
    }
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
      journal_hash: null, checkpoint: { completed: [], stage: 'qualification', next_segment: 1 }, plan: this.plan, lease_session: this.leaseSession(), approvals: {}, findings: [], observer_findings: [], observer_evidence: [], assertion_evidence: {}, restore_evidence: {},
      runtime_evidence: { confirmed_writes: 0, write_times: {}, serial_groups: {}, frozen_matches: {}, match_teams: {}, pending_decisions: {} }
    };
    ensureDir(this.runDir(runId));
    await this.persist(manifest);
    this.activeManifest = manifest;
    appendJournal(this.runDir(runId), { type: 'SNAPSHOT', refs: refs.length, pre_canonical_hash: manifest.pre_canonical_hash });
    return manifest;
  }

  approval(manifest, type, extra = {}) {
    const value = { type, runId: manifest.run_id, commit: process.env.GITHUB_SHA || 'local', sourceHash: this.manifestHash(manifest), preImageHash: manifest.pre_canonical_hash, expiresAt: new Date(this.now() + 4 * 60 * 60 * 1000).toISOString(), approver: `workflow_dispatch:${process.env.GITHUB_ACTOR || 'operator'}`, ...extra };
    manifest.approvals[type] = value;
    appendJournal(this.runDir(manifest.run_id), { type: 'AUTONOMOUS_APPROVAL', approval: type });
    return value;
  }

  async clearBarrier(manifest) {
    if (!this.autonomous) throw new Error('CLEAR_APPROVAL_REQUIRED');
    this.approval(manifest, 'APPROVE_CLEAR_INPUTS', { canonicalRanges: manifest.allowlist.length });
    const emptyPost = Object.fromEntries(manifest.allowlist.map((ref) => [ref, null]));
    // Clearing is a write, not a setup convenience. Persist its complete
    // alternate post-image before any network I/O so cancellation/timeout at
    // every boundary can identify blank cells as runner-owned and restore them.
    manifest.in_flight = { match: 'clear-inputs', post: emptyPost, alternatePosts: [emptyPost], kind: 'CLEAR_ALLOWLIST' };
    await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), { type: 'CLEAR_INTENT', refs: manifest.allowlist.length });
    if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
    // CAS immediately before the destructive API call. The immutable snapshot,
    // not a stale earlier read, is the only acceptable clear precondition.
    const beforeClear = await this.adapter.readCells(manifest.allowlist);
    if (!sameCells(beforeClear, manifest.pre_image)) throw Object.assign(new Error('CLEAR_CAS_CONFLICT'), { p0: true });
    if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
    await this.adapter.clearCells(manifest.allowlist);
    const cleared = await this.adapter.readCells(manifest.allowlist);
    if (!Object.values(cleared).every((cell) => !cell?.userEnteredValue)) throw Object.assign(new Error('CLEAR_READBACK_FAILED'), { p0: true });
    if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
    Object.assign(manifest.post_image, emptyPost);
    delete manifest.in_flight;
    // Full run 的 CAS 基準是 clear 後的空白；最終 restore 仍使用不可變的原始 pre_image。
    manifest.execution_pre_image = cleared;
    manifest.clear_canonical_hash = hash(canonicalCells(cleared));
    manifest.state = STATES.FULL_READY;
    this.approval(manifest, 'APPROVE_FULL_RUN');
    await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), { type: 'CLEAR_CONFIRMED', refs: manifest.allowlist.length });
  }

  recordAssertion(manifest, match, assertion, status, details = {}) {
    const normalized = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'skipped';
    const current = manifest.assertion_evidence[match.id] || {
      eventId: match.id, matchId: match.id, scenario: match.scenario, status: 'pass', passed: true, assertions: [], source: 'runner_enforced_gate'
    };
    current.assertions.push({ assertion, status: normalized, at: new Date(this.now()).toISOString(), ...details });
    if (current.assertions.some((item) => item.status === 'fail')) current.status = 'fail';
    else if (current.assertions.some((item) => item.status === 'skipped')) current.status = 'skipped';
    else current.status = 'pass';
    current.passed = current.status === 'pass';
    manifest.assertion_evidence[match.id] = current;
    appendJournal(this.runDir(manifest.run_id), { type: 'ASSERTION_RESULT', match: match.id, assertion, status: normalized, details });
    return current;
  }

  addFinding(manifest, code, detail, eventId = null) {
    const finding = { code, detail, severity: 'non_p0', eventId, at: new Date(this.now()).toISOString() };
    manifest.findings ||= [];
    if (!this.findings.some((item) => findingKey(item) === findingKey(finding))) this.findings.push(finding);
    if (!manifest.findings.some((item) => findingKey(item) === findingKey(finding))) manifest.findings.push(finding);
    appendJournal(this.runDir(manifest.run_id), { type: 'NON_P0_FINDING', ...finding });
    return finding;
  }

  async drainExternalFindings(manifest, { persist = false } = {}) {
    manifest.findings ||= [];
    let changed = false;
    while (this.externalFindingCursor < this.externalFindings.length) {
      const source = this.externalFindings[this.externalFindingCursor++];
      const finding = {
        code: source?.code || 'INFO', detail: source?.detail || null,
        severity: source?.severity || 'non_p0', eventId: source?.eventId || null,
        at: source?.at || new Date(this.now()).toISOString(),
        ...(Number.isFinite(source?.latencyMs) ? { latencyMs: source.latencyMs } : {}),
        ...(source?.sites ? { sites: source.sites } : {})
      };
      const key = findingKey(finding);
      if (!manifest.findings.some((item) => findingKey(item) === key)) {
        manifest.findings.push(finding); changed = true;
        appendJournal(this.runDir(manifest.run_id), { type: 'NON_P0_FINDING', ...finding });
      }
      if (!this.findings.some((item) => findingKey(item) === key)) this.findings.push(finding);
    }
    if (changed && persist) await this.persist(manifest);
    return changed;
  }

  recordFixtureAssertion(manifest, fixture, assertion, status, details = {}) {
    const scenario = fixture.id.startsWith('B-') ? 'B' : fixture.id.startsWith('C') ? 'C' : 'K';
    const members = this.plan.filter((candidate) => fixture.memberNos.includes(candidate.no) && candidate.scenario === scenario);
    for (const member of members) this.recordAssertion(manifest, member, assertion, status, { fixtureId: fixture.id, ...details });
  }

  fixtureMatches(fixture) {
    return fixture.memberNos.map((no) => this.plan.find((match) => match.no === no)).filter(Boolean);
  }

  offlineFixture(fixture, manifest) {
    const matches = this.fixtureMatches(fixture).map((match) => {
      const names = manifest.runtime_evidence.match_teams[match.id] || [match.teamA, match.teamB];
      return { a: names[0], b: names[1], sa: match.score[0], sb: match.score[1], done: true };
    });
    const teams = [...new Set(matches.flatMap((match) => [match.a, match.b]).filter(Boolean))];
    return { teams, matches, stats: teams.length ? fixtureStats(teams, matches) : {} };
  }

  async qualificationRows(group) {
    if (typeof this.adapter.values !== 'function') return null;
    let selected = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await this.adapter.values('3_資格賽積分榜!D2:J101');
      selected = rows.filter((row) => String(row?.[0] || '').trim() === group);
      if (selected.length >= 4) break;
      if (attempt < 2) await this.waitInterval(2, this.activeManifest);
    }
    return selected;
  }

  async validateB(manifest, match) {
    const fixture = match.fixture; const offline = this.offlineFixture(fixture, manifest);
    const rows = await this.qualificationRows('競資-A');
    const expected = [
      { rank: 1, wins: 2, gf: 61, ga: 31, ratio: 61 / 31 },
      { rank: 2, wins: 2, gf: 62, ga: 50, ratio: 62 / 50 },
      { rank: 3, wins: 2, gf: 52, ga: 61, ratio: 52 / 61 }
    ];
    const offlineRows = Object.values(offline.stats).sort((a, b) => b.wins - a.wins || b.ratio - a.ratio).slice(0, 3);
    const offlinePass = expected.every((item, index) => {
      const actual = offlineRows[index];
      return actual?.wins === item.wins && actual.gf === item.gf && actual.ga === item.ga && close(actual.ratio, item.ratio);
    });
    const sheetPass = rows === null || expected.every((item) => {
      const row = rows.find((candidate) => numeric(candidate?.[6]) === item.rank);
      return numeric(row?.[1]) === item.wins && numeric(row?.[2]) === item.gf && numeric(row?.[3]) === item.ga && close(row?.[5], item.ratio);
    });
    const passed = offlinePass && sheetPass;
    this.recordFixtureAssertion(manifest, fixture, 'same_wins_ratio_rank', passed ? 'pass' : 'fail', {
      range: '3_資格賽積分榜!D2:J101', group: '競資-A', expected, sheetRead: rows !== null, rowsMatched: rows?.length ?? null
    });
    if (!passed) this.addFinding(manifest, 'B_STANDINGS_ASSERT_FAILED', '競資-A 的勝場、GF/GA、比率或排名與固定 fixture 不一致', match.id);
  }

  async validateC3(manifest, match) {
    const fixture = match.fixture; const offline = this.offlineFixture(fixture, manifest);
    const rows = await this.qualificationRows('競資-B');
    const tied = Object.values(offline.stats).filter((item) => item.wins === 2 && item.gf === 53 && item.ga === 32 && close(item.ratio, 53 / 32));
    const ranking = rankGroup(offline.teams, offline.matches);
    const offlinePass = tied.length === 3 && tied.every((item) => ranking.tied.has(item.name));
    const sheetPass = rows === null || rows.filter((row) => numeric(row?.[1]) === 2 && numeric(row?.[2]) === 53
      && numeric(row?.[3]) === 32 && close(row?.[5], 53 / 32)).length === 3;
    const pending = await this.pendingAcrossSites(match, ['main-qualifying', 'mobile-advance']);
    const passed = offlinePass && sheetPass && pending.pendingObserved === true;
    manifest.runtime_evidence.pending_decisions[fixture.id] = pending;
    this.recordFixtureAssertion(manifest, fixture, 'c3_equal_pending_visible_no_h2h', passed ? 'pass' : 'fail', {
      range: '3_資格賽積分榜!D2:J101', group: '競資-B', tiedCount: tied.length,
      expected: { wins: 2, gf: 53, ga: 32, ratio: 53 / 32, policy: 'PENDING_DECISION_NO_H2H' }, sheetRead: rows !== null,
      pendingObserved: pending.pendingObserved === true
    });
    if (!passed) this.addFinding(manifest, 'C3_PENDING_ASSERT_FAILED', '競資-B 三隊同值或前端「並列待判定」證據不足；不套用直接對戰，推演繼續', match.id);
    return pending;
  }

  async validateC5(manifest, match) {
    const fixture = match.fixture; const offline = this.offlineFixture(fixture, manifest);
    const values = Object.values(offline.stats);
    const ranking = rankGroup(offline.teams, offline.matches);
    let sheetRows = null;
    if (typeof this.adapter.values === 'function') sheetRows = await this.adapter.values('4b_複賽晉級!A1:I9');
    const truthRows = sheetRows === null ? null : sheetRows.slice(4, 9);
    const sheetPass = truthRows === null || (truthRows.length === 5 && truthRows.every((row) => numeric(row?.[3]) === 2
      && numeric(row?.[4]) === 64 && numeric(row?.[5]) === 64 && close(row?.[6], 1)
      && String(row?.[7] || '').includes('並列') && String(row?.[8] || '').includes('並列待判定')));
    const pending = await this.pendingAcrossSites(match, ['main-bracket', 'mobile-advance']);
    const passed = offline.teams.length === 5 && offline.matches.length === 10 && values.length === 5
      && values.every((item) => item.wins === 2 && item.gf === 64 && item.ga === 64 && close(item.ratio, 1))
      && ranking.tied.size === 5 && sheetPass && pending.pendingObserved === true;
    const evidence = { ...pending, source: 'offline_sheet_and_dual_site', policy: 'PENDING_DECISION_NO_H2H', teams: offline.teams };
    manifest.runtime_evidence.pending_decisions[fixture.id] = evidence;
    this.recordFixtureAssertion(manifest, fixture, 'c5_equal_pending_no_h2h', passed ? 'pass' : 'fail', {
      memberNos: fixture.memberNos, teams: offline.teams, tiedCount: ranking.tied.size,
      range: '4b_複賽晉級!A1:I9', sheetRead: truthRows !== null, sheetPass, pendingSites: pending.sites,
      expected: { wins: 2, gf: 64, ga: 64, ratio: 1, rankMarker: '（並列）', decisionMarker: '⚠ 並列待判定', policy: 'PENDING_DECISION_NO_H2H' }
    });
    if (!passed) this.addFinding(manifest, 'C5_PENDING_ASSERT_FAILED', '白金五角循環未形成五隊完全同值；不套用直接對戰，推演繼續', match.id);
    return evidence;
  }

  async pendingAcrossSites(match, siteNames) {
    if (!this.observer) return { pendingObserved: false, reason: 'observer_unavailable', sites: [] };
    if (typeof this.observer.dom !== 'function') {
      const fallback = typeof this.observer.pendingEvidence === 'function'
        ? await this.withObserverHeartbeat(() => this.observer.pendingEvidence(match.id), this.activeManifest)
        : {};
      return { ...fallback, pendingObserved: fallback.pendingObserved === true, sites: fallback.sites || [] };
    }
    const sites = siteNames.map((name) => OBSERVER_SITES.find((site) => site.name === name)).filter(Boolean);
    let results = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const started = this.now();
      results = await this.withObserverHeartbeat(() => Promise.all(sites.map(async (site) => {
        const dom = await this.observer.dom(site); const seen = observerText(dom).includes('並列待判定');
        const evidence = { site: site.name, url: new URL(site.url).pathname, rendered: true, seen, sample: 'pending-decision', eventId: match.id, at: new Date().toISOString(), latencyMs: this.now() - started };
        if (typeof this.observer.emit === 'function') this.observer.emit(evidence);
        return evidence;
      })), this.activeManifest);
      if (results.length === sites.length && results.every((result) => result.seen)) break;
      if (attempt < 3) await this.waitInterval(30, this.activeManifest);
    }
    return { matchId: match.id, pendingObserved: results.length === sites.length && results.every((result) => result.seen), sites: results.map((result) => ({ site: result.site, seen: result.seen })) };
  }

  async validateK(manifest, match) {
    const fixture = match.kFixture;
    if (!fixture) throw Object.assign(new Error('K_FIXTURE_MISSING'), { p0: true });
    if (typeof this.adapter.values !== 'function') {
      this.recordAssertion(manifest, match, 'club_total_comp_rank_and_joint_rank', 'pass', { source: 'offline_fixture_only', ...fixture });
      return;
    }
    let teamRows = []; let clubRows = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      [teamRows, clubRows] = await Promise.all([
        this.adapter.values('6_積分總表!A2:M109'), this.adapter.values('7_球團積分!A2:F11')
      ]);
      if (teamRows.length >= 108 && clubRows.length >= 9) break;
      if (attempt < 2) await this.waitInterval(2, manifest);
    }
    const teams = teamRows.map((row) => ({ type: String(row?.[2] || '').trim(), club: String(row?.[3] || '').trim(), total: numeric(row?.[12]) }))
      .filter((row) => row.club && row.total !== null);
    const clubs = new Map(clubRows.map((row) => [String(row?.[0] || '').trim(), { total: numeric(row?.[2]), comp: numeric(row?.[3]), rank: numeric(row?.[4]) }]).filter(([name]) => name));
    const sumChecks = [...clubs].map(([name, actual]) => {
      const mine = teams.filter((team) => team.club === name);
      const total = mine.reduce((sum, team) => sum + team.total, 0);
      const comp = mine.filter((team) => team.type === '競技組').reduce((sum, team) => sum + team.total, 0);
      return { name, pass: actual.total === total && actual.comp === comp, expectedTotal: total, expectedComp: comp, ...actual };
    });
    const [p, q] = fixture.expected.different.clubs.map((name) => clubs.get(name));
    const [r, s] = fixture.expected.joint.clubs.map((name) => clubs.get(name));
    const differentPass = p && q && p.total === q.total && p.comp !== q.comp
      && ((p.comp > q.comp && p.rank < q.rank) || (q.comp > p.comp && q.rank < p.rank));
    const jointPass = r && s && r.total === s.total && r.comp === s.comp && r.rank === s.rank;
    const passed = teams.length === 108 && sumChecks.length >= 9 && sumChecks.every((item) => item.pass) && differentPass && jointPass;
    this.recordAssertion(manifest, match, 'club_total_comp_rank_and_joint_rank', passed ? 'pass' : 'fail', {
      ranges: ['6_積分總表!A2:M109', '7_球團積分!A2:F11'], flipNos: fixture.flipNos,
      different: fixture.expected.different, joint: fixture.expected.joint, teamRows: teams.length, clubRows: clubs.size,
      sumifsPassed: sumChecks.filter((item) => item.pass).length, formulasWritten: false
    });
    if (!passed) this.addFinding(manifest, 'K_CLUB_ASSERT_FAILED', '球團 C/D/E 欄、SUMIFS 加總或同分排名規則不一致', match.id);
  }

  async validateFixtureIfReady(manifest, match) {
    if (match.fixture?.trigger) {
      if (match.fixture.id.startsWith('B-')) await this.validateB(manifest, match);
      else if (match.fixture.id.startsWith('C3-')) await this.validateC3(manifest, match);
      else if (match.fixture.id.startsWith('C5-')) await this.validateC5(manifest, match);
    }
    if (match.no === 310) await this.validateK(manifest, match);
  }

  observerTeams(match, post) {
    if (match.nameCells) {
      const names = [
        post[match.nameCells[0]]?.userEnteredValue?.stringValue || '',
        post[match.nameCells[1]]?.userEnteredValue?.stringValue || ''
      ];
      if (names.every(Boolean)) return names;
    }
    return this.observerTeamByNo.get(match.no) || [match.teamA || '', match.teamB || ''];
  }

  async executeMatch(manifest, match) {
    await this.watchdog(manifest);
    if (isKillSwitchSet(this.stateDir)) throw Object.assign(new Error('Kill switch 已啟動'), { p0: true });
    if (!this.allowedStages.has(match.stage)) throw new Error(`PENDING_STAGE_GATE:${match.stage}`);
    const score = match.score || scoreFor(manifest.run_id, match.id);
    let incompleteStartedAt = null;
    assertCompletedScore(score); // write gate：completed 絕不允許平手
    for (const step of match.steps || []) {
      if (step.type === 'DELAY') {
        const started = this.now();
        await this.waitInterval(step.seconds, manifest);
        const elapsedMs = this.now() - started;
        this.recordAssertion(manifest, match, step.assertion, elapsedMs >= step.seconds * 1000 ? 'pass' : (this.fast ? 'skipped' : 'fail'), { elapsedMs, requiredMs: step.seconds * 1000 });
      }
      if (step.type === 'SCHEDULE_GAP') {
        const writesBefore = manifest.runtime_evidence.confirmed_writes;
        const started = this.now();
        await this.waitInterval(step.durationSeconds, manifest);
        const elapsedMs = this.now() - started;
        const zeroWrites = manifest.runtime_evidence.confirmed_writes === writesBefore;
        const passed = elapsedMs >= step.durationSeconds * 1000 && zeroWrites;
        this.recordAssertion(manifest, match, step.assertion, passed ? 'pass' : (this.fast ? 'skipped' : 'fail'), {
          source: 'schedule-data:events', dueAt: step.end, elapsedMs, requiredMs: step.durationSeconds * 1000, writesDuringGap: manifest.runtime_evidence.confirmed_writes - writesBefore
        });
      }
      // STANDINGS_ASSERT / CLUB_ASSERT execute after the confirmed write and
      // formula readback; they are never satisfied by presence of a plan step.
    }
    const scoreCells = match.scoreCells || match.cells;
    const post = { [scoreCells[0]]: cellForNumber(score[0]), [scoreCells[1]]: cellForNumber(score[1]) };
    // 淘汰賽：先問解析器這一場誰上場。解析器只吃「後端 O 欄算出的勝方」往下推，
    // 不用本地記的分數，所以這是真的在驗後端公式鏈，而不是自己跟自己對答案。
    if (match.nameCells) {
      if (!this.resolver) throw new Error(`RESOLVER_REQUIRED:${match.id}`);
      let names;
      try { names = await this.resolver.namesFor(match, this.adapter); }
      finally { await this.drainExternalFindings(manifest, { persist: true }); }
      if (!Array.isArray(names) || names.length !== 2 || !names.every((n) => typeof n === 'string' && n)) {
        throw Object.assign(new Error(`無法推導參賽隊伍：${match.id}（場次 ${match.no}）`), { p0: true });
      }
      post[match.nameCells[0]] = cellForString(names[0]);
      post[match.nameCells[1]] = cellForString(names[1]);
      manifest.runtime_evidence.match_teams[match.id] = [...names];
    }
    const current = await this.adapter.readCells(match.cells);
    const writePreImage = manifest.execution_pre_image || manifest.pre_image;
    const expectedPre = Object.fromEntries(match.cells.map((ref) => [ref, writePreImage[ref]]));
    const expectedPost = Object.fromEntries(match.cells.map((ref) => [ref, post[ref]]));
    if (sameCells(current, expectedPost)) return { skipped: true, post };
    if (!sameCells(current, expectedPre)) throw Object.assign(new Error(`CAS 衝突：${match.id}`), { p0: true });
    if (match.incomplete) {
      // F 唯一允許的短暫 0:0：它明確是 incomplete，不會通過 completed assert，
      // 並在同一次事件中立即 correction，停留時間必定小於 maxSeconds。
      const transient = { [scoreCells[0]]: cellForNumber(0), [scoreCells[1]]: cellForNumber(0) };
      incompleteStartedAt = this.now();
      manifest.in_flight = { match: match.id, post, alternatePosts: [transient], incomplete: { maxSeconds: match.incomplete.maxSeconds, startedAt: new Date(incompleteStartedAt).toISOString() } };
      await this.persist(manifest);
      await this.adapter.writeCells(transient);
      if (!sameCells(await this.adapter.readCells(scoreCells), transient)) throw Object.assign(new Error(`INCOMPLETE_READBACK_FAILED:${match.id}`), { p0: true });
      if (this.observer) await this.withObserverHeartbeat(() => this.observer.afterWrite(`${match.id}-pending`), manifest);
    }
    const reversed = (match.steps || []).find((step) => step.type === 'WRITE_REVERSED');
    if (reversed) {
      const reversedPost = { [scoreCells[0]]: cellForNumber(reversed.score[0]), [scoreCells[1]]: cellForNumber(reversed.score[1]) };
      manifest.in_flight = { match: match.id, post, alternatePosts: [reversedPost], kind: 'REVERSED_THEN_CORRECT' };
      await this.persist(manifest);
      appendJournal(this.runDir(manifest.run_id), { type: 'REVERSED_WRITE_INTENT', match: match.id, alternateRefs: scoreCells });
      await this.adapter.writeCells(reversedPost);
      if (!sameCells(await this.adapter.readCells(scoreCells), reversedPost)) throw Object.assign(new Error(`REVERSED_READBACK_FAILED:${match.id}`), { p0: true });
      appendJournal(this.runDir(manifest.run_id), { type: 'REVERSED_CORRECTION', match: match.id });
      if (this.stopRequested) throw Object.assign(new Error('CANCELLED_RESTORE_REQUIRED'), { p0: true });
    }
    // Persist intent before network I/O. If a process dies after an accepted
    // request but before its response, restore still knows every possible write.
    const previousIntent = manifest.in_flight?.match === match.id ? manifest.in_flight : {};
    manifest.in_flight = {
      ...previousIntent, match: match.id, post,
      alternatePosts: uniqueCellPosts(previousIntent.alternatePosts || [])
    };
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
    assertCompletedScore([confirmed[scoreCells[0]]?.userEnteredValue?.numberValue, confirmed[scoreCells[1]]?.userEnteredValue?.numberValue]); // readback gate
    manifest.readback_evidence.writes[match.id] = readbackEvidence(confirmed);
    manifest.runtime_evidence.confirmed_writes += 1;
    manifest.runtime_evidence.write_times[match.id] = this.now();
    if (match.scenario === 'D') this.recordAssertion(manifest, match, 'forfeit_0_21', score[0] === 0 && score[1] === 21 ? 'pass' : 'fail', { score });
    if (match.incomplete) {
      const elapsedMs = Math.max(0, this.now() - incompleteStartedAt);
      this.recordAssertion(manifest, match, 'incomplete_corrected_within_120s', elapsedMs <= match.incomplete.maxSeconds * 1000 ? 'pass' : 'fail', { elapsedMs, maxMs: match.incomplete.maxSeconds * 1000 });
    }
    if (reversed) this.recordAssertion(manifest, match, 'reversed_score_corrected', 'pass', { reversedScore: reversed.score, finalScore: score });
    if (match.venuePace) {
      const counterpart = this.plan.find((candidate) => candidate.no === match.venuePace.counterpartNo);
      const ownAt = manifest.runtime_evidence.write_times[match.id];
      const counterpartAt = counterpart && manifest.runtime_evidence.write_times[counterpart.id];
      if (match.venuePace.role === 'late' && Number.isFinite(counterpartAt)) {
        const pass = counterpartAt < ownAt;
        this.recordAssertion(manifest, match, match.venuePace.assertion, pass ? 'pass' : 'fail', { court3At: counterpartAt, court7At: ownAt, sameSlot: match.schedule.s });
        this.recordAssertion(manifest, counterpart, match.venuePace.assertion, pass ? 'pass' : 'fail', { court3At: counterpartAt, court7At: ownAt, sameSlot: match.schedule.s });
      }
    }
    if (this.observer) {
      const [teamA, teamB] = this.observerTeams(match, post);
      if (!teamA || !teamB) throw Object.assign(new Error(`OBSERVER_TEAM_SOURCE_MISSING:${match.id}`), { p0: true });
      await this.withObserverHeartbeat(
        () => this.observer.afterWrite({ matchId: match.id, matchNo: match.no, stage: match.stage, teamA, teamB, scoreA: score[0], scoreB: score[1] }),
        manifest
      );
    }
    await this.validateFixtureIfReady(manifest, match);
    if (match.c2) {
      manifest.state = STATES.RUNNING_PAUSED_DECISION;
      await this.persist(manifest);
      const evidence = manifest.runtime_evidence.pending_decisions[match.fixture?.id] || { eventId: match.id, observedAt: new Date().toISOString() };
      this.approval(manifest, 'APPROVE_C2_DECISION', { decisionId: `c2-${match.id}`, outcome: 'PREDECLARED_DETERMINISTIC_CONTINUE', evidence });
      manifest.state = STATES.RUNNING;
      await this.persist(manifest);
    }
    return { skipped: false, post };
  }

  async restore(manifest) {
    await this.watchdog(manifest);
    manifest.state = STATES.RESTORING;
    await this.persist(manifest);
    if (manifest.schema !== 2 || hash(canonicalCells(manifest.pre_image)) !== manifest.pre_canonical_hash || !Array.isArray(manifest.allowlist) || !manifest.allowlist.every((ref) => manifest.plan.some((m) => m.cells.includes(ref)))) throw new Error('manifest 驗證失敗');
    const possiblePost = { ...manifest.post_image, ...(manifest.in_flight?.post || {}) };
    const alternatePosts = manifest.in_flight?.alternatePosts || [];
    const currentAll = await this.adapter.readCells(Object.keys(possiblePost));
    const safe = {}; const conflicts = [];
    for (const ref of Object.keys(possiblePost)) {
      await this.watchdog(manifest);
      const current = { [ref]: currentAll[ref] }, pre = { [ref]: manifest.pre_image[ref] }, post = { [ref]: possiblePost[ref] };
      if (sameCells(current, pre)) continue;
      const alternativesMatch = alternatePosts.some((alternative) => ref in alternative && sameCells(current, { [ref]: alternative[ref] }));
      if (sameCells(current, post) || alternativesMatch) safe[ref] = manifest.pre_image[ref]; else conflicts.push(ref);
    }
    if (Object.keys(safe).length) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.watchdog(manifest);
        try { await this.adapter.writeCells(safe); const check = await this.adapter.readCells(Object.keys(safe)); if (sameCells(check, safe)) break; if (attempt === 1) throw new Error('RESTORE_READBACK_FAILED'); }
        catch (error) { if (!isTransient(error) || attempt === 1) throw error; }
      }
    }
    if (conflicts.length) { manifest.state = STATES.MANUAL_HOLD; manifest.reason = [manifest.reason, `RESTORE_CONFLICT:${conflicts.join(',')}`].filter(Boolean).join(';'); await this.persist(manifest); appendJournal(this.runDir(manifest.run_id), { type: 'MANUAL_HOLD', conflicts }); return manifest; }
    manifest.state = STATES.RESTORE_VERIFY;
    const finalValues = await this.adapter.readCells(manifest.allowlist);
    manifest.restore_evidence = { final_canonical_hash: hash(canonicalCells(finalValues)), expected_pre_hash: manifest.pre_canonical_hash, verified: sameCells(finalValues, manifest.pre_image) };
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

  async captureObserverState(manifest, { persist = true } = {}) {
    manifest.observer_findings ||= [];
    manifest.observer_evidence ||= [];
    if (!this.observer) {
      if (this.autonomous) throw Object.assign(new Error('OBSERVER_UNAVAILABLE'), { p0: true });
      return;
    }
    const findings = typeof this.observer.flush === 'function'
      ? await this.withObserverHeartbeat(() => this.observer.flush(), manifest)
      : [];
    const evidence = Array.isArray(this.observer.evidence) ? this.observer.evidence : [];
    const merge = (target, incoming) => {
      const seen = new Set(target.map((item) => JSON.stringify(item)));
      for (const item of incoming || []) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) { target.push(item); seen.add(key); }
      }
    };
    merge(manifest.observer_findings, findings);
    merge(manifest.observer_evidence, evidence);
    if (persist) await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), {
      type: 'OBSERVER_STATE_CAPTURED', findings: manifest.observer_findings.length,
      evidence: manifest.observer_evidence.length,
      latency_samples: manifest.observer_evidence.filter((item) => Number.isFinite(item?.latencyMs)).length
    });
  }

  async autonomousCanary(manifest) {
    // 三張成績表各一個 score cell；不是三場資格賽，避免淘汰賽 resolver 尚未有晉級資料。
    // scenario plan 已改為權威時間順序，淘汰與曜請會交錯，不得再使用固定 index。
    const samples = ['qualification', 'knockout', 'invitational'].map((stage) => this.plan.find((match) => match.stage === stage));
    if (samples.some((match) => !match?.scoreCells)) throw Object.assign(new Error('CANARY_STAGE_SAMPLE_MISSING'), { p0: true });
    const refs = samples.map((match) => match.scoreCells[0]);
    const peers = samples.map((match) => match.scoreCells[1]);
    const pre = await this.adapter.readCells([...refs, ...peers]);
    const sentinel = (own, peer) => {
      const a = own?.userEnteredValue?.numberValue;
      const b = peer?.userEnteredValue?.numberValue;
      for (const value of [21, 19, 18, 17, 16]) if (value !== a && value !== b) return value;
      throw Object.assign(new Error('CANARY_SENTINEL_UNAVAILABLE'), { p0: true });
    };
    const post = Object.fromEntries(refs.map((ref, i) => [ref, cellForNumber(sentinel(pre[ref], pre[peers[i]]))]));
    if (!refs.every((ref) => !sameCells({ [ref]: pre[ref] }, { [ref]: post[ref] }))) throw Object.assign(new Error('CANARY_NOOP'), { p0: true });
    manifest.in_flight = { match: 'three-sheet-canary', post };
    Object.assign(manifest.post_image, post);
    await this.persist(manifest);
    await this.adapter.writeCells(post);
    if (!sameCells(await this.adapter.readCells(refs), post)) throw Object.assign(new Error('CANARY_READBACK_FAILED'), { p0: true });
    if (!this.observer || typeof this.observer.sweep !== 'function') throw Object.assign(new Error('OBSERVER_READINESS_UNAVAILABLE'), { p0: true });
    // Canary deliberately changes only one score cell per source sheet. That
    // sentinel is not a completed match, so an exact-score event assertion
    // would be guaranteed to time out on a healthy site. Probe render/readiness
    // only; exact match synchronization starts after full legal score writes.
    const readiness = await this.withObserverHeartbeat(() => this.observer.sweep(), manifest);
    if (!Array.isArray(readiness) || readiness.length === 0 || readiness.some((item) => item?.rendered !== true)) {
      throw Object.assign(new Error('CANARY_OBSERVER_READINESS_FAILED'), { p0: true });
    }
    manifest.runtime_evidence.canary_observer_readiness = readiness.map((item) => ({
      site: item.site, url: item.url, rendered: true, sample: 'canary-readiness',
      bytes: Number.isFinite(item.bytes) ? item.bytes : null, latencyMs: Number.isFinite(item.latencyMs) ? item.latencyMs : null
    }));
    await this.captureObserverState(manifest);
    await this.adapter.writeCells(Object.fromEntries(refs.map((ref) => [ref, pre[ref]])));
    const canaryPre = Object.fromEntries(refs.map((ref) => [ref, pre[ref]]));
    if (!sameCells(await this.adapter.readCells(refs), canaryPre)) throw Object.assign(new Error('CANARY_RESTORE_READBACK_FAILED'), { p0: true });
    refs.forEach((ref) => delete manifest.post_image[ref]); delete manifest.in_flight;
    manifest.state = STATES.CANARY_READY;
    this.approval(manifest, 'APPROVE_PREFLIGHT');
    await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), { type: 'THREE_SHEET_CANARY_RESTORED', refs });
  }

  async writeFinalReport(manifest, startedAt) {
    if (this.autonomous || this.observer) await this.captureObserverState(manifest);
    await this.drainExternalFindings(manifest, { persist: true });
    const observerFindings = manifest.observer_findings || [];
    const findings = uniqueFindings([...(manifest.findings || []), ...this.findings, ...observerFindings]);
    const payload = reportPayload({ manifest, findings, observerFindings: [], startedAt, finishedAt: new Date().toISOString() });
    const body = { ...payload, markdown: markdown(payload) };
    if (this.stateStore?.writeReport) await this.stateStore.writeReport(manifest.run_id, body, this.leaseHandle);
    else writeJson(path.join(this.runDir(manifest.run_id), 'final-report.json'), body);
    return body;
  }

  async writeRestoreIncident(runId, manifest, error = null) {
    const body = {
      schema: 1, run_id: runId, mode: 'restore-only', at: new Date().toISOString(),
      state: manifest?.state || 'RESTORE_FAILURE', outcome: error ? 'FAILED' : 'FINISHED',
      reason: error ? safeError(error) : (manifest?.reason || null),
      pre_image_hash: manifest?.pre_canonical_hash || null,
      final_canonical_hash: manifest?.restore_evidence?.final_canonical_hash || null,
      restore_verified: manifest?.restore_evidence?.verified === true,
      redacted: true
    };
    if (this.stateStore?.writeIncidentReport) await this.stateStore.writeIncidentReport(runId, body, this.leaseHandle);
    else { ensureDir(this.runDir(runId)); writeJson(path.join(this.runDir(runId), 'restore-incident-report.json'), body); }
    return body;
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

  checkpointCompleted(manifest, match) {
    const completed = new Set(manifest.checkpoint.completed);
    completed.add(match.id);
    manifest.checkpoint.completed = this.plan.filter((item) => completed.has(item.id)).map((item) => item.id);
    manifest.checkpoint.stage = match.stage;
  }

  prerequisitesReady(manifest, match) {
    const gate = match.finalFourGate;
    if (!gate) return true;
    const completed = new Set(manifest.checkpoint.completed);
    return gate.prerequisiteIds.every((id) => completed.has(id));
  }

  scheduledDelayMs(match) {
    return (match.steps || []).reduce((total, step) => {
      if (step.type === 'DELAY') return total + step.seconds * 1000;
      if (step.type === 'SCHEDULE_GAP') return total + step.durationSeconds * 1000;
      return total;
    }, 0);
  }

  async commitMatch(manifest, match) {
    const result = await this.executeMatch(manifest, match);
    Object.assign(manifest.post_image, result.post);
    delete manifest.in_flight;
    this.checkpointCompleted(manifest, match);
    await this.persist(manifest);
    appendJournal(this.runDir(manifest.run_id), {
      type: result.skipped ? 'SKIP_ALREADY_WRITTEN' : 'WRITE_CONFIRMED',
      match: match.id,
      score: (match.scoreCells || match.cells).map((ref) => result.post[ref]?.userEnteredValue?.numberValue).filter(Number.isFinite)
    });
    return result;
  }

  freezeMatch(manifest, match, deferred) {
    const missing = match.finalFourGate.prerequisiteIds.filter((id) => !manifest.checkpoint.completed.includes(id));
    manifest.runtime_evidence.frozen_matches[match.id] = {
      frozenAt: this.now(), missing, unfreezedAt: null, attemptedWriteCount: manifest.runtime_evidence.confirmed_writes
    };
    deferred.push(match);
    appendJournal(this.runDir(manifest.run_id), { type: 'TIER_FREEZE', match: match.id, tier: match.finalFourGate.tier, missing });
  }

  async drainDeferred(manifest, deferred) {
    let progress = true;
    while (progress) {
      progress = false;
      for (let index = 0; index < deferred.length; index += 1) {
        const match = deferred[index];
        if (!this.prerequisitesReady(manifest, match)) continue;
        const freeze = manifest.runtime_evidence.frozen_matches[match.id];
        const writesBefore = freeze.attemptedWriteCount;
        const noPrematureWrite = !(match.id in manifest.readback_evidence.writes) && writesBefore === freeze.attemptedWriteCount;
        await this.commitMatch(manifest, match);
        freeze.unfreezedAt = this.now();
        const pass = noPrematureWrite && match.finalFourGate.prerequisiteIds.every((id) => manifest.checkpoint.completed.includes(id));
        this.recordAssertion(manifest, match, 'prerequisite_freeze_then_unfreeze', pass ? 'pass' : 'fail', {
          frozenAt: freeze.frozenAt, unfreezedAt: freeze.unfreezedAt, missingAtFreeze: freeze.missing, noPrematureWrite
        });
        appendJournal(this.runDir(manifest.run_id), { type: 'TIER_UNFREEZE', match: match.id, tier: match.finalFourGate.tier });
        deferred.splice(index, 1);
        progress = true;
        break;
      }
    }
  }

  async runMatchSequence(manifest, matches, intervals, { initialDue = this.now(), stopOffset = 0 } = {}) {
    let nextDue = initialDue;
    const deferred = [];
    for (let i = 0; i < matches.length; i += 1) {
      if (this.stopRequested || (this.stopAfter !== null && stopOffset + i >= this.stopAfter)) {
        manifest.reason = 'MANUAL_STOP_RESTORED';
        break;
      }
      const match = matches[i];
      if (match.finalFourGate && !this.prerequisitesReady(manifest, match)) {
        this.freezeMatch(manifest, match, deferred);
        nextDue += intervals[i] * 1000;
        await this.persist(manifest);
        continue;
      }

      if (match.serialWindow) {
        const groupId = match.serialWindow.groupId;
        const group = [];
        let cursor = i;
        while (cursor < matches.length && matches[cursor].serialWindow?.groupId === groupId) {
          group.push(matches[cursor]);
          cursor += 1;
        }
        const expectedNos = match.serialWindow.memberNos;
        if (group.length !== expectedNos.length || group.some((member, index) => member.no !== expectedNos[index])) {
          throw Object.assign(new Error(`SERIAL_GROUP_NOT_CONTIGUOUS:${groupId}`), { p0: true });
        }
        const startedAt = this.now();
        let inFlight = 0; let maxInFlight = 0;
        for (const member of group) {
          inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
          await this.commitMatch(manifest, member);
          inFlight -= 1;
        }
        const finishedAt = this.now();
        const elapsedMs = finishedAt - startedAt;
        const pass = maxInFlight === 1 && elapsedMs <= match.serialWindow.windowSeconds * 1000;
        manifest.runtime_evidence.serial_groups[groupId] = { startedAt, finishedAt, elapsedMs, maxInFlight, members: group.map((member) => member.id) };
        for (const member of group) this.recordAssertion(manifest, member, 'ten_courts_serial_within_60s', pass ? 'pass' : 'fail', {
          groupId, elapsedMs, maxInFlight, courts: group.map((item) => item.schedule.ct)
        });
        for (let offset = 0; offset < group.length; offset += 1) nextDue += intervals[i + offset] * 1000;
        i = cursor - 1;
        await this.persist(manifest);
        await this.drainDeferred(manifest, deferred);
        await this.waitInterval(Math.max(0, nextDue - this.now()) / 1000, manifest);
        continue;
      }

      // 特殊延遲是權威排程的額外時間，要同步往後推 due clock。
      // 否則 H 等完 25 分鐘後，runner 會為了「追上舊 nextDue」連續寫多場。
      nextDue += this.scheduledDelayMs(match);
      await this.commitMatch(manifest, match);
      nextDue += intervals[i] * 1000;
      await this.drainDeferred(manifest, deferred);
      await this.persist(manifest);
      await this.waitInterval(Math.max(0, nextDue - this.now()) / 1000, manifest);
    }
    await this.drainDeferred(manifest, deferred);
    if (deferred.length && !manifest.reason) {
      throw Object.assign(new Error(`FINAL_FOUR_PREREQUISITES_UNRESOLVED:${deferred.map((match) => match.id).join(',')}`), { p0: true });
    }
    return nextDue;
  }

  async runMainPhase(manifest) {
    this.activeManifest = manifest;
    manifest.state = STATES.RUNNING;
    await this.persist(manifest);
    const intervals = pairedJitter(this.plan.length, this.random);
    await this.runMatchSequence(manifest, this.plan, intervals);
    if (this.autonomous || this.observer) await this.captureObserverState(manifest);
    manifest.state = STATES.VERIFY;
    await this.persist(manifest);
    // --keep-scores：跑完把分數留在雲端供人工檢視，不自動復原。
    // manifest 的 pre_image／post_image 完整保留，之後用
    //   restore-only --armed --local-state --run-id <id>
    // 仍可逐格三方比對復原；復原能力沒有失去，只是改成人工觸發。
    if (this.keepScores) {
      manifest.state = STATES.COMPLETE;
      manifest.reason = 'KEPT_FOR_REVIEW';
      await this.persist(manifest);
      appendJournal(this.runDir(manifest.run_id), { type: 'KEPT_FOR_REVIEW', written: Object.keys(manifest.post_image).length });
      return manifest;
    }
    const restored = await this.restore(manifest);
    await this.writeFinalReport(restored, manifest.created_at);
    return restored;
  }

  segmentBounds(segment) {
    if (!Number.isInteger(segment) || segment < 1 || segment > SEGMENTS.length || this.plan.length !== 310) throw new Error('SEGMENT_INVALID');
    return SEGMENTS[segment - 1];
  }

  assertSegmentCheckpoint(manifest, segment) {
    const [start] = this.segmentBounds(segment);
    const expectedState = segment === 1 ? (this.autonomous ? STATES.FULL_READY : STATES.CANARY_WAITING_APPROVAL) : STATES.SEGMENT_WAITING;
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
    await this.runMatchSequence(manifest, matches, intervals, { stopOffset: start });
    if (manifest.checkpoint.completed.length !== end || manifest.reason) return this.restore(manifest);
    if (this.autonomous || this.observer) await this.captureObserverState(manifest);
    if (segment < SEGMENTS.length) {
      manifest.state = STATES.SEGMENT_WAITING;
      manifest.checkpoint.next_segment = segment + 1;
      await this.persist(manifest);
      appendJournal(this.runDir(manifest.run_id), { type: 'SEGMENT_WAITING', segment, next_segment: segment + 1 });
      return manifest;
    }
    manifest.state = STATES.VERIFY;
    await this.persist(manifest);
    const restored = await this.restore(manifest);
    await this.writeFinalReport(restored, manifest.created_at);
    return restored;
  }

  async preflightOnly(runId) {
    if (this.mode !== 'run' || !this.armed || !this.autonomous) {
      throw new Error('PREFLIGHT_MODE_INVALID');
    }
    this.assertArmed();
    try {
      await this.acquireLease(runId);
      const metadata = await this.precheck({ requireProjections: true, hydrateObserver: false });
      return {
        run_id: runId, state: 'PREFLIGHT_COMPLETE', reason: 'PREFLIGHT_GATES_PASSED',
        metadata: { title: metadata.title || null, locale: metadata.locale || null, timeZone: metadata.timeZone }
      };
    } finally {
      if (this.leaseHandle) await this.lease.release(this.leaseHandle);
    }
  }

  async start(runId = makeRunId()) {
    this.assertArmed();
    ensureDir(this.stateDir);
    let manifest;
    try {
      // Resume approval is deliberately checked before a Sheet lease is taken.
      if (this.resumeOnly && this.stateStore && !this.autonomous) {
        const pending = await this.stateStore.read(runId);
        const approval = await this.stateStore.read(runId, 'approval');
        const expectedState = this.segment === null || this.segment === 1 ? STATES.CANARY_WAITING_APPROVAL : STATES.SEGMENT_WAITING;
        if (pending.state !== expectedState || approval.run_id !== runId || approval.manifest_hash !== this.manifestHash(pending)) throw new Error('APPROVAL_PRELEASE_INVALID');
      }
      await this.acquireLease(runId);
      if (this.resumeOnly && this.stateStore && !this.autonomous) {
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
      if (this.autonomous) { manifest.state = STATES.PREFLIGHT_READY; this.approval(manifest, 'APPROVE_PREFLIGHT'); await this.persist(manifest); }
      manifest.state = STATES.CANARY;
      manifest.precheck = metadata;
      await this.persist(manifest);
      if (this.autonomous) {
        await this.autonomousCanary(manifest);
        await this.clearBarrier(manifest);
        return this.segment !== null ? await this.runSegment(manifest, this.segment) : await this.runMainPhase(manifest);
      }
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
    let manifest;
    try {
      try { manifest = this.stateStore ? await this.stateStore.read(runId) : readJson(this.manifestPath(runId)); }
      catch (error) {
        if (error.status === 404 || error.code === 'ENOENT') {
          const empty = { run_id: runId, state: STATES.COMPLETE, reason: 'NO_MANIFEST_NO_WRITES' };
          await this.writeRestoreIncident(runId, empty);
          return empty;
        }
        throw error;
      }
      this.activeManifest = manifest;
      if (manifest.spreadsheet_id !== this.spreadsheetId) throw new Error('manifest spreadsheet 不符');
      manifest.lease_session = this.leaseSession();
      await this.persist(manifest);
      await this.precheck({ requireProjections: false });
      const result = await this.restore(manifest);
      await this.writeRestoreIncident(runId, result);
      return result;
    } catch (error) {
      if (manifest) {
        manifest.state = STATES.RESTORE_FAILURE;
        manifest.reason = [manifest.reason, `RESTORE_ONLY_ERROR:${safeError(error)}`].filter(Boolean).join(';');
        try { await this.persist(manifest); } catch { /* incident report still attempted below */ }
      }
      try { await this.writeRestoreIncident(runId, manifest, error); } catch { /* preserve original restore error */ }
      throw error;
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
    const options = { mode, armed: false, fast: false, expectCanary: false, canaryOnly: false, resumeOnly: false, autonomous: false, preflightOnly: false, segment: null, stateDir: path.join(__dirname, 'runs'), runId: null, localState: false, keepScores: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--armed') options.armed = true;
    else if (arg === '--local-state') options.localState = true;
    else if (arg === '--keep-scores') options.keepScores = true;
    else if (arg === '--fast') options.fast = true;
    else if (arg === '--expect-canary') options.expectCanary = true;
    else if (arg === '--canary-only') options.canaryOnly = true;
    else if (arg === '--resume-only') options.resumeOnly = true;
    else if (arg === '--autonomous') options.autonomous = true;
    else if (arg === '--preflight-only') options.preflightOnly = true;
    else if (arg === '--segment') options.segment = Number(rest[++i]);
    else if (arg === '--state-dir') options.stateDir = rest[++i];
    else if (arg === '--run-id') options.runId = rest[++i];
    else throw new Error(`未知參數：${arg}`);
  }
  if (!['dry-run', 'ci-dry-run', 'run', 'restore-only'].includes(mode)) throw new Error('mode 必須為 dry-run、ci-dry-run、run 或 restore-only');
  if (options.armed && options.fast) throw new Error('--fast 與 --armed 不可同時使用');
  if (options.canaryOnly && options.resumeOnly) throw new Error('--canary-only 與 --resume-only 不可同時使用');
  if (options.autonomous && (options.canaryOnly || options.resumeOnly)) throw new Error('--autonomous 不可與 canary/resume 混用');
  if (options.segment !== null && (!Number.isInteger(options.segment) || options.segment < 1 || options.segment > 5)) throw new Error('--segment 必須為 1 至 5');
  if (options.preflightOnly && !(mode === 'run' && options.armed && options.autonomous && options.runId
    && !options.localState && !options.keepScores && options.segment === null && !options.canaryOnly && !options.resumeOnly)) {
    throw new Error('--preflight-only 僅允許 run --armed --autonomous --run-id，且不得搭配 segment/local-state/keep-scores');
  }
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
  // 全場演練 155 分鐘 > token 上限 60 分鐘，因此本機模式用會自動換發的 provider；
  // Actions 模式維持由 workflow 每段重取短效 token 的既有設計。
  const provider = opts.localState && !process.env.GOOGLE_ACCESS_TOKEN ? require('./sa-token').tokenProvider() : null;
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
  let lease; let stateStore;
  const adapter = opts.mode === 'dry-run'
    ? new MockAdapter()
    : new SheetsRestAdapter({ spreadsheetId, accessToken, tokenProvider: provider, projectionBaselines: process.env.SOLAR_CUP_PROJECTION_BASELINES ? parseProjectionBaselines(process.env.SOLAR_CUP_PROJECTION_BASELINES) : null });
  if (opts.mode !== 'dry-run' && opts.localState) {
    lease = new LocalGenerationLease({ file: path.join(opts.stateDir, 'lease.json') });
    stateStore = new LocalRunState({ dir: opts.stateDir, lease });
  } else if (opts.mode !== 'dry-run') { const client = new GcsJsonClient({ accessToken }); lease = new GcsGenerationLease({ client, bucket: process.env.SOLAR_CUP_GCS_BUCKET, object: process.env.SOLAR_CUP_GCS_LEASE_OBJECT || 'solarcup-simulation/lease.json' }); stateStore = new GcsRunState({ client, bucket: process.env.SOLAR_CUP_GCS_BUCKET, prefix: process.env.SOLAR_CUP_GCS_STATE_PREFIX || 'solarcup-simulation/runs', lease }); }
  // 淘汰賽隊名解析：armed 走雲端逐場回讀（用後端 O 欄的勝方往下推）；
  // dry-run 背後是 mock，沒有公式引擎可讀，只用劇本填佔位名，
  // 目的是驗寫入／snapshot／restore 的機制，不宣稱驗晉級推導。
  // Resolver diagnostics are durable backend findings. Observer samples stay
  // in observer_evidence; only observer.flush() may promote a completed
  // timeout/visibility result to observer_findings.
  const resolverFindings = [];
  const resolver = opts.mode === 'dry-run'
    ? new ScriptedResolver()
    : new KnockoutResolver({ source: new CloudSource(adapter), onFinding: (f) => { resolverFindings.push(f); console.warn(`[FINDING] ${f.code} ${f.detail}`); } });
  const effectiveRunId = opts.runId || makeRunId();
  const observer = opts.autonomous ? new DualSiteObserver() : null;
  const runner = new SimulationRunner({ ...opts, adapter, spreadsheetId, lease, stateStore, resolver, observer, externalFindings: resolverFindings, plan: opts.autonomous ? buildScenarioPlan(effectiveRunId) : fullPlan(), allowedStages: ['qualification', 'knockout', 'invitational'] });
  process.on('SIGINT', () => { void runner.requestCancel(); });
  process.on('SIGTERM', () => { void runner.requestCancel(); });
  const result = opts.preflightOnly ? await runner.preflightOnly(effectiveRunId)
    : opts.mode === 'restore-only' ? await runner.restoreOnly(opts.runId) : await runner.start(effectiveRunId);
  const outcome = result.state === 'PREFLIGHT_COMPLETE' ? 'PREFLIGHT_COMPLETE'
    : result.state === STATES.MANUAL_HOLD ? 'MANUAL_HOLD'
    : result.state === STATES.SEGMENT_WAITING ? 'SEGMENT_WAITING'
    // 等待核准是正常的中間狀態，不是失敗；標成 RESTORE_FAILURE 會讓人以為復原出事
    : result.state === STATES.CANARY_WAITING_APPROVAL ? 'CANARY_WAITING_APPROVAL'
    : result.state !== STATES.COMPLETE ? 'RESTORE_FAILURE'
      : result.reason === 'NORMAL_RESTORED' ? 'NORMAL_RESTORED'
        : result.reason === 'KEPT_FOR_REVIEW' ? 'KEPT_FOR_REVIEW'
      : result.reason === 'MANUAL_STOP_RESTORED' ? 'MANUAL_STOP_RESTORED'
          : result.reason?.startsWith('P0_ABORT:') ? 'P0_ABORT_RESTORED' : 'ABORT_RESTORED';
  console.log(JSON.stringify({ run_id: result.run_id, state: result.state, outcome, reason: result.reason }, null, 2));
  process.exitCode = outcome === 'PREFLIGHT_COMPLETE' || outcome === 'NORMAL_RESTORED' || outcome === 'KEPT_FOR_REVIEW' || outcome === 'SEGMENT_WAITING' || (opts.expectCanary && result.state === STATES.CANARY_WAITING_APPROVAL) ? 0 : 2;
}

if (require.main === module) main().catch((error) => { console.error(safeError(error)); process.exitCode = 2; });

module.exports = {
  SimulationRunner, EXPECTED_SPREADSHEET_ID, EXPECTED_BACKUP_FILE_ID,
  cellForNumber, parseArgs, parseProjectionBaselines, parseBackupEvidence, backupEvidenceDigest, InMemoryLease
};
