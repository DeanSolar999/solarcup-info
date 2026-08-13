'use strict';

/* site-engine.js — bracket-tree.html headless 直跑引擎（正式工具）
   ════════════════════════════════════════════════════════════
   【角色（2026-08-13 銜接校準後收斂）】
   ① 拓撲常數解析：MNO 場次結構、SEATS、TIERS——loadTopology()
   ② 雲端結果重放驗證：把雲端（或演練 write-plan）的比分快照灌進
      網站自己的 buildTier 原始邏輯，取回站方視角的名次榜、並列
      旗標、placePts、冠亞季殿——replayVerify()
   結構推演已死：2026-08-12 bracket-tree 雲端化改版（playM 只讀雲端、
   隊名空＝待定、rrMembers＝雲端聯集、季殿＝雲端 #third 列），加上
   2026-08-12 團長定案「初賽配對＝現場抽籤」，網站與本引擎都不再
   捏造任何配對。舊 deriveSeating（結構推演、建 finalrun write-plan
   f2bd687c 所用）已移除，歷史正本封存於
   ~/Desktop/曜日盃賽務資料/推演executor備份_20260811/site-engine-v1-structural.js。

   【機制】不移植、不改寫：每次評估都從 HTML 現檔摘取邏輯段原文，
   在 vm 隔離執行環境跑（vm.runInNewContext，timeout 5s）。
   摘取兩層存在性驗證（N16）：① regex 錨點 ② 執行後 shape 驗證。
   網站再改版 → 錨點移動 → fail-closed 於 SITE_EXTRACT_*。

   ⚠️【隔離強度：不是安全邊界，禁餵不可信程式碼】⚠️
   context 內 process／require／fetch／fs／module／global 都不可達
   （sandboxIsolationProbe() 可自證），這擋得住的是「網站原始碼意外
   觸及本機資源」與無窮迴圈——僅止於此。
   node:vm 官方定位本來就不是 security boundary：經典的
       this.constructor.constructor('return process.pid')()
   在本環境實測仍可取回真正的 host process，等於完全逃逸。
   因此本引擎「僅」用於執行本專案自有的 bracket-tree.html。
   嚴禁餵入不可信來源的程式碼（外部 HTML、使用者輸入、第三方片段），
   任何要跑不可信輸入的需求都必須改用真正的沙箱（獨立進程 ＋ OS 級
   權限限制／容器），不得沿用本檔。 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SITE = path.join(__dirname, '..');
const BRACKET_HTML = path.join(SITE, 'bracket-tree.html');
const EXTRACT_END_ANCHOR = '// ---- 概覽泳道 ----';

// ── 摘取（第 ① 層：regex 錨點，對齊 2026-08-12 雲端化改版）────
// RR_PAIRS／TRI_PAIRS／makePool／poolFromTD 已隨改版刪除，不再是錨點；
// 新錨點涵蓋雲端化核心：teamFromCloud／TBD_DRAW／rrMembers／rrAmbiguity。
const REQUIRED_DECLARATIONS = [
  /\bconst BASE=\{/u,
  /\bconst TIERS=\[/u,
  /\bconst MNO=\{/u,
  /\bconst SEATS=\[/u,
  /\bfunction setLiveData\s*\(/u,
  /\bfunction teamFromCloud\s*\(/u,
  /\bfunction TBD_DRAW\s*\(/u,
  /\bfunction playM\s*\(/u,
  /\bfunction rrMembers\s*\(/u,
  /\bfunction rrRank\s*\(/u,
  /\bfunction rrAmbiguity\s*\(/u,
  /\bfunction buildTier\s*\(/u
];

let _cachedCode = null;
let _cachedMtime = null;
function extractEngineSource() {
  const mtime = fs.statSync(BRACKET_HTML).mtimeMs;
  if (_cachedCode && _cachedMtime === mtime) return _cachedCode;
  const html = fs.readFileSync(BRACKET_HTML, 'utf8');
  const baseMatch = html.match(/const BASE=\{[^\n]*\};/u);
  if (!baseMatch) throw new Error('SITE_EXTRACT_BASE_MISSING（bracket-tree 又改版？重校準錨點，見檔頭）');
  const start = html.search(/\bconst TIERS=\[/u);
  const end = html.indexOf(EXTRACT_END_ANCHOR);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('SITE_EXTRACT_BOUNDS（bracket-tree 又改版？重校準錨點，見檔頭）');
  }
  const segment = html.slice(start, end);
  for (const pattern of REQUIRED_DECLARATIONS) {
    if (!pattern.test(segment) && !pattern.test(baseMatch[0])) {
      throw new Error(`SITE_EXTRACT_DECLARATION_MISSING:${pattern.source}`);
    }
  }
  _cachedCode = `${baseMatch[0]}\n${segment}\n;({setLiveData,buildTier,TIERS,MNO,SEATS,DATA,REG});`;
  _cachedMtime = mtime;
  return _cachedCode;
}

// ── 執行後驗證（第 ② 層：shape）──────────────────────────────
// RR_PAIRS 沒了，改以 MNO 每級的輪次結構數量補位驗證。
function assertEngineShape(engine) {
  if (typeof engine?.setLiveData !== 'function' || typeof engine?.buildTier !== 'function') {
    throw new Error('SITE_ENGINE_SHAPE:exports_not_callable');
  }
  const keys = (engine.TIERS || []).map((t) => t?.key);
  if (JSON.stringify(keys) !== '["plat","gold","silver","bronze"]') throw new Error(`SITE_ENGINE_SHAPE:TIERS:${keys}`);
  if (!Array.isArray(engine.SEATS) || engine.SEATS.length !== 10) throw new Error('SITE_ENGINE_SHAPE:SEATS');
  const expect = {
    plat: { pre: 10, rrA: 10, rrB: 10, sf: 2 },
    gold: { pre: 10, rrA: 10, rrB: 10, sf: 2 },
    silver: { pre: 15, tri: 3, ko: 6, qf: 4, sf: 2 },
    bronze: { pre: 15, tri: 3, ko: 6, qf: 4, sf: 2 }
  };
  const nos = [];
  for (const key of keys) {
    const M = engine.MNO?.[key];
    if (!M) throw new Error(`SITE_ENGINE_SHAPE:MNO_TIER:${key}`);
    for (const [round, count] of Object.entries(expect[key])) {
      if (!Array.isArray(M[round]) || M[round].length !== count) {
        throw new Error(`SITE_ENGINE_SHAPE:MNO_ROUND:${key}.${round}:${M[round]?.length}/${count}`);
      }
      nos.push(...M[round]);
    }
    if (!Number.isInteger(M.final) || !Number.isInteger(M.third)) throw new Error(`SITE_ENGINE_SHAPE:MNO_MEDAL:${key}`);
    nos.push(M.final, M.third);
  }
  if (nos.length !== 132 || new Set(nos).size !== 132 || nos.some((n) => !Number.isInteger(n) || n < 151 || n > 310)) {
    throw new Error(`SITE_ENGINE_SHAPE:MNO_132:${nos.length}`);
  }
  return engine;
}

// ── 隔離評估：每次全新 context（DATA／REG／TBD 計數歸零）────────
// 輸入只能是本專案自有的 bracket-tree.html——見檔頭「不是安全邊界」警告。
function freshEngine() {
  const SolarCupData = require(path.join(SITE, 'tournament-data.js')).SolarCupData;
  const code = extractEngineSource();
  const sandbox = { SolarCupData, window: { SolarCupData } };
  const engine = vm.runInNewContext(code, vm.createContext(sandbox), {
    timeout: 5000, filename: 'bracket-tree.extracted.js'
  });
  return assertEngineShape(engine);
}

// 隔離自證（測試／審計用）：context 內 process、require、fetch、fs、module 不可達。
// 注意：isolated:true 只代表「沒有意外洩漏的全域」，不代表 vm 是安全邊界——
// this.constructor.constructor 類逃逸仍然可行，詳見檔頭警告。
function sandboxIsolationProbe() {
  const sandbox = vm.createContext({ SolarCupData: {}, window: {} });
  const probe = (expr) => vm.runInNewContext(`typeof ${expr}`, sandbox, { timeout: 1000 });
  const result = {
    process: probe('process'), require: probe('require'),
    fetch: probe('fetch'), fs: probe('fs'), module: probe('module')
  };
  const leaked = Object.entries(result).filter(([, type]) => type !== 'undefined');
  return { result, isolated: leaked.length === 0, leaked };
}

// ── ① 拓撲常數解析 ───────────────────────────────────────────
function loadTopology() {
  const engine = freshEngine();
  const knockoutNos = [];
  for (const key of ['plat', 'gold', 'silver', 'bronze']) {
    const M = engine.MNO[key];
    knockoutNos.push(...M.pre, ...(M.rrA || []), ...(M.rrB || []), ...(M.tri || []),
      ...(M.ko || []), ...(M.qf || []), ...M.sf, M.final, M.third);
  }
  knockoutNos.sort((a, b) => a - b);
  return {
    MNO: engine.MNO, SEATS: engine.SEATS,
    tiers: engine.TIERS.map((t) => ({ key: t.key, name: t.name, type: t.type, kind: t.kind })),
    knockoutNos
  };
}

/* ── ② 雲端結果重放驗證 ──────────────────────────────────────
   liveMatches：{'<場次>': {a,b,sa,sb,done}}（淘汰賽需 a/b 隊名；
   資格賽只需 sa/sb 供資料層分流）。灌進網站原始 buildTier，回傳
   站方視角＋一致性 findings（只記不改）：
     ILLEGAL_SCORE     比分非 21 分單局終局（0:0／平手／越界）
     SELF_MATCH        同隊互打
     NAME_NOT_ROSTER   雲端隊名不在名冊（站上會照雲端顯示，記 finding）
     UNKNOWN_MATCH_NO  151–310 淘汰賽鍵不在拓撲內 */
function replayVerify(liveMatches) {
  const engine = freshEngine();
  const topology = loadTopology();
  const findings = [];
  const knockSet = new Set(topology.knockoutNos);
  const inviteNos = new Set((require(path.join(SITE, 'tournament-data.js')).SolarCupData.INVITE_SCHEDULE || []).map((sc) => sc[0]));
  for (const [key, r] of Object.entries(liveMatches || {})) {
    const no = Number(key);
    if (!(no >= 151 && no <= 310) || inviteNos.has(no)) continue;
    if (!knockSet.has(no)) { findings.push({ code: 'UNKNOWN_MATCH_NO', no }); continue; }
    if (!r || !r.done) continue;
    const { sa, sb } = r;
    const legal = Number.isInteger(sa) && Number.isInteger(sb) && sa !== sb
      && ((sa === 21 && sb >= 0 && sb <= 20) || (sb === 21 && sa >= 0 && sa <= 20));
    if (!legal) findings.push({ code: 'ILLEGAL_SCORE', no, sa, sb });
    if (r.a && r.b && r.a === r.b) findings.push({ code: 'SELF_MATCH', no, label: r.a });
  }

  engine.setLiveData({ matches: liveMatches, hasReal: true });
  const rosterLabels = new Set(
    require(path.join(SITE, 'tournament-data.js')).SolarCupData.buildAllTeams(null).teams.map((t) => t.label)
  );
  const view = { rr: {}, tri: {}, medals: {}, points: null, doneCount: 0 };
  for (const tier of engine.TIERS) {
    const d = engine.buildTier(tier);
    if (tier.type === 'comp') {
      d.standings.forEach((st, gi) => {
        view.rr[`${tier.key}.${gi === 0 ? 'rrA' : 'rrB'}`] = {
          ranked: st.map((x) => x.label),
          tied: st.filter((x) => x._tied || x.tied).map((x) => x.label),
          pendingDecision: st.some((x) => x._tied || x.tied)
        };
      });
    } else {
      view.tri[tier.key] = {
        ranked: d.triRank.map((x) => x.label),
        tied: d.triRank.filter((x) => x._tied || x.tied).map((x) => x.label),
        pendingDecision: d.triRank.some((x) => x._tied || x.tied)
      };
    }
    view.medals[tier.key] = {
      champion: d.champ?.label || null, runnerUp: d.runner?.label || null,
      third: d.thirdW?.label || null,
      thirdPair: d.thirdM ? [d.thirdM.a?.label || null, d.thirdM.b?.label || null] : null
    };
  }
  const points = new Map();
  for (const team of Object.values(engine.REG)) {
    if (!team || !team.label || team.pending) continue;
    points.set(team.label, { base: team.base || 0, placePts: team.placePts || 0, stage: team.stage });
    if (!rosterLabels.has(team.label)) findings.push({ code: 'NAME_NOT_ROSTER', label: team.label });
  }
  view.points = points;
  view.doneCount = topology.knockoutNos.filter((no) => liveMatches[String(no)]?.done).length;
  return { view, findings, topology };
}

/* deriveSeating（結構推演）＝已移除。
   凡呼叫者收到此錯誤：write-plan f2bd687c 已凍結、不需重建；
   歷史重建請用 Desktop 備份的 site-engine-v1-structural.js。 */
function deriveSeating() {
  throw new Error('DERIVE_SEATING_REMOVED：結構推演已死（2026-08-12 雲端化＋現場抽籤定案）。重放驗證請用 replayVerify()；歷史重建見 推演executor備份_20260811/site-engine-v1-structural.js');
}

module.exports = {
  extractEngineSource, freshEngine, assertEngineShape, sandboxIsolationProbe,
  loadTopology, replayVerify, deriveSeating, BRACKET_HTML
};
