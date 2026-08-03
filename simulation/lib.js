'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATES = Object.freeze({
  PRECHECK: 'PRECHECK', SNAPSHOT: 'SNAPSHOT', CANARY: 'CANARY',
  CANARY_WAITING_APPROVAL: 'CANARY_WAITING_APPROVAL', SEGMENT_WAITING: 'SEGMENT_WAITING',
  RUNNING: 'RUNNING', VERIFY: 'VERIFY', RESTORING: 'RESTORING',
  RESTORE_VERIFY: 'RESTORE_VERIFY', COMPLETE: 'COMPLETE',
  RESTORE_FAILURE: 'RESTORE_FAILURE', MANUAL_HOLD: 'MANUAL_HOLD', CANCELLED_RESTORE_REQUIRED: 'CANCELLED_RESTORE_REQUIRED'
});

function stable(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function hash(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function same(a, b) {
  return hash(a) === hash(b);
}

// Google returns effective/formatted metadata that can legitimately change when
// formulas recalculate. Safety comparisons therefore use only the exact input
// payload that the runner can write: CellData.userEnteredValue and its type.
function canonicalCell(cell) {
  const value = cell?.userEnteredValue;
  if (!value) return null;
  const keys = ['numberValue', 'stringValue', 'boolValue', 'formulaValue', 'errorValue'];
  const key = keys.find((candidate) => Object.hasOwn(value, candidate));
  return key ? { type: key, value: value[key] } : null;
}

function canonicalCells(cells) {
  return Object.fromEntries(Object.entries(cells).map(([ref, cell]) => [ref, canonicalCell(cell)]));
}

function sameCells(a, b) {
  return same(canonicalCells(a), canonicalCells(b));
}

function readbackEvidence(cells) {
  return Object.fromEntries(Object.entries(cells).map(([ref, cell]) => [ref, {
    effectiveValue: cell?.effectiveValue ?? null,
    formattedValue: cell?.formattedValue ?? null
  }]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRunId(now = new Date()) {
  return `sim-${now.toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function scoreFor(runId, matchId) {
  const bytes = crypto.createHmac('sha256', runId).update(String(matchId)).digest();
  const loser = bytes[0] % 20;
  const aWins = (bytes[1] & 1) === 0;
  return aWins ? [21, loser] : [loser, 21];
}

function assertLegalScore(score) {
  if (!Array.isArray(score) || score.length !== 2 || !score.every(Number.isInteger)) {
    throw new Error('比分必須為 2 個整數');
  }
  const [a, b] = score;
  if (a === b || !((a === 21 && b >= 0 && b <= 19) || (b === 21 && a >= 0 && a <= 19))) {
    throw new Error(`非法比分：${a}:${b}`);
  }
}

// Every adjacent pair sums to 60 seconds. Each individual interval has a
// uniform 20–40 second marginal distribution, while the complete even-length
// plan remains exactly 30 seconds per match on average.
function pairedJitter(count, random = Math.random) {
  const values = [];
  for (let i = 0; i < count; i += 2) {
    if (i === count - 1) {
      values.push(30);
      break;
    }
    const x = 20 + random() * 20;
    if (random() < 0.5) values.push(x, 60 - x);
    else values.push(60 - x, x);
  }
  return values;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendJournal(runDir, event) {
  fs.appendFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

// cells＝這一場會被寫到、因此也必須納入 snapshot／restore 的全部儲存格。
// scoreCells 固定是分數；nameCells 只有淘汰賽才有——資格賽與曜請組的隊伍
// 是賽前預填的，模擬不得改動。
function qualMatch(index) {
  const row = index + 2;
  return {
    id: `qual-${index + 1}`, stage: 'qualification', no: index + 1,
    scoreCells: [`2_資格賽成績!K${row}`, `2_資格賽成績!L${row}`], nameCells: null,
    cells: [`2_資格賽成績!K${row}`, `2_資格賽成績!L${row}`]
  };
}
function defaultPlan() {
  return Array.from({ length: 150 }, (_, index) => qualMatch(index));
}
function fullPlan(knockoutNos) {
  // 淘汰賽的隊名（J/L）沒有任何系統在推導，是賽務現場手填的。模擬若只寫分數，
  // 編號反查與勝方公式會全部回傳空，`6_積分總表` 的止步一律「—」、名次分一律 0，
  // 等於整條積分鏈路都沒驗到卻不會報錯。因此 J/L 必須一併納入 plan。
  const nos = knockoutNos || require('./bracket').knockoutNumbers(require('./bracket').loadTopology());
  if (nos.length !== 132) throw new Error(`KNOCKOUT_PLAN_SIZE:${nos.length}/132`);
  const qualification = defaultPlan();
  const knockout = nos.map((no, i) => {
    const row = i + 2;
    const nameCells = [`4_淘汰賽成績!J${row}`, `4_淘汰賽成績!L${row}`];
    const scoreCells = [`4_淘汰賽成績!M${row}`, `4_淘汰賽成績!N${row}`];
    return { id: `knockout-${i + 1}`, stage: 'knockout', no, nameCells, scoreCells, cells: [...nameCells, ...scoreCells] };
  });
  const invitational = Array.from({ length: 28 }, (_, i) => {
    const row = i + 2;
    return {
      id: `invitational-${i + 1}`, stage: 'invitational', no: null,
      scoreCells: [`5_曜請成績!J${row}`, `5_曜請成績!K${row}`], nameCells: null,
      cells: [`5_曜請成績!J${row}`, `5_曜請成績!K${row}`]
    };
  });
  return [...qualification, ...knockout, ...invitational];
}

function isKillSwitchSet(stateDir) {
  return fs.existsSync(path.join(stateDir, 'KILL_SWITCH'));
}

// Journal and console output are operational evidence, not a place to retain
// remote responses or credentials. Prefer a stable error code whenever one is
// available and only allow a small, local-safe subset of text otherwise.
function safeError(error) {
  if (error?.code) return `ERROR:${String(error.code).replace(/[^A-Z0-9_:-]/gi, '_')}`;
  if (Number.isInteger(error?.status)) return `HTTP:${error.status}`;
  const text = String(error?.message || error || 'UNKNOWN_ERROR')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  return text.slice(0, 160);
}

module.exports = {
  STATES, stable, hash, same, clone, makeRunId, scoreFor, assertLegalScore,
  canonicalCell, canonicalCells, sameCells, readbackEvidence,
  pairedJitter, ensureDir, writeJson, readJson, appendJournal, defaultPlan, fullPlan,
  isKillSwitchSet, safeError
};
