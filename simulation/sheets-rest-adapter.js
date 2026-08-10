'use strict';

const { clone, hash, fullPlan } = require('./lib');
const { loadTopology, knockoutNumbers } = require('./bracket');
const scheduleData = require('../schedule-data.js');

const SPREADSHEET_ID = '1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
const BACKUP_FILE_ID = '15WHaxX9Qa-6-tw9XzQ-G0LgkzdxxGDbHqLv8dZ048RM';
const SHEET_POLICY = Object.freeze({
  '2_資格賽成績': { sheetId: 252930776, rows: [2, 151], columns: new Set(['K', 'L']) },
  // J/L＝淘汰賽隊名。這兩欄現場是賽務手填的，沒有任何公式在推導；模擬若不寫，
  // 編號反查與勝方公式全部回傳空，整條積分鏈路會安靜地算成 0。刻意納入寫入範圍，
  // snapshot／三方復原也因此自動涵蓋這兩欄。
  '4_淘汰賽成績': { sheetId: 1125219206, rows: [2, 133], columns: new Set(['J', 'L', 'M', 'N']) },
  '5_曜請成績': { sheetId: 848445550, rows: [2, 29], columns: new Set(['J', 'K']) }
});
const PROJECTION_RANGES = Object.freeze({
  '3': '3_資格賽積分榜!A1:Z109', '6': '6_積分總表!A1:Z109',
  '7': '7_球團積分!A1:Z11', '8': '8_發布_戰情看板!A1:Z311'
});
const PROJECTION_SHAPES = Object.freeze({
  '3': { rows: 109, columns: 26 }, '6': { rows: 109, columns: 26 },
  '7': { rows: 11, columns: 26 }, '8': { rows: 311, columns: 26 }
});

function canonicalProjectionValues(id, values) {
  const shape = PROJECTION_SHAPES[id];
  if (!shape) throw new Error(`PROJECTION_SHAPE_MISSING:${id}`);
  return Array.from({ length: shape.rows }, (_, rowIndex) => {
    const row = Array.isArray(values?.[rowIndex]) ? values[rowIndex] : [];
    return Array.from({ length: shape.columns }, (_, columnIndex) => {
      const value = row[columnIndex];
      // Sheets Values REST uses '' for formula-produced blanks and omits
      // trailing blank cells/rows. The connector returns the same cells as
      // null in a fixed rectangle. Both are one semantic projection state.
      return value === '' || value === null || value === undefined ? null : value;
    });
  });
}

function projectionHashMismatch(id, actual, expected) {
  const safeId = String(id).replace(/[^0-9]/g, '') || 'UNKNOWN';
  const safeActual = /^[a-f0-9]{64}$/i.test(actual) ? actual.toLowerCase() : 'INVALID_ACTUAL_HASH';
  const safeExpected = /^[a-f0-9]{64}$/i.test(expected) ? expected.toLowerCase() : 'INVALID_EXPECTED_HASH';
  const error = new Error(`projection ${safeId} hash mismatch`);
  // safeError preserves explicit error codes. These values are hashes of
  // public projection ranges, not credentials, so production logs may expose
  // them to diagnose which canonical baseline drifted before any write.
  error.code = `PROJECTION_HASH_MISMATCH:${safeId}:ACTUAL:${safeActual}:EXPECTED:${safeExpected}`;
  error.projectionId = safeId;
  error.actualHash = safeActual;
  error.expectedHash = safeExpected;
  return error;
}

function canonicalScheduleRows() {
  const matches = scheduleData?.matches;
  if (!Array.isArray(matches) || matches.length !== 310) {
    throw new Error(`AUTHORITATIVE_SCHEDULE_DATA_COUNT:${matches?.length ?? 0}/310`);
  }
  const allNos = matches.map((match) => match?.n);
  if (new Set(allNos).size !== 310 || allNos.some((no, index) => !Number.isInteger(no) || no !== index + 1)) {
    throw new Error('AUTHORITATIVE_SCHEDULE_DATA_NOT_COMPLETE');
  }
  const rows = {
    qualification: matches.filter((match) => match.stage === '資格賽').map((match) => match.n),
    knockout: matches.filter((match) => match.n > 150 && match.grp !== '曜請組').map((match) => match.n),
    invitational: matches.filter((match) => match.grp === '曜請組').map((match) => match.n)
  };
  const expectedCounts = { qualification: 150, knockout: 132, invitational: 28 };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (rows[key].length !== expected) throw new Error(`AUTHORITATIVE_SCHEDULE_STAGE_COUNT:${key}:${rows[key].length}/${expected}`);
  }
  const union = Object.values(rows).flat().sort((a, b) => a - b);
  if (new Set(union).size !== 310 || union.some((no, index) => no !== index + 1)) {
    throw new Error('AUTHORITATIVE_SCHEDULE_STAGE_PARTITION_INVALID');
  }
  const topologyNos = knockoutNumbers(loadTopology());
  if (JSON.stringify(rows.knockout) !== JSON.stringify(topologyNos)) {
    throw new Error('AUTHORITATIVE_SCHEDULE_TOPOLOGY_MISMATCH');
  }
  return rows;
}

class SheetsRestAdapter {
  constructor({ spreadsheetId, accessToken, tokenProvider = null, requestTimeoutMs = 10_000, armedGateVerifier = null, projectionBaselines = null }) {
    if (spreadsheetId !== SPREADSHEET_ID) throw new Error('Spreadsheet allowlist 不符');
    if (!accessToken && !tokenProvider) throw new Error('缺少 GOOGLE_ACCESS_TOKEN');
    this.spreadsheetId = spreadsheetId;
    this.accessToken = accessToken;
    // 全場演練跑 155 分鐘，Google access token 上限 1 小時——
    // 固定 token 會在中途整批 401，所以要能換發。
    this.tokenProvider = tokenProvider;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
    this.sheetIds = {};
    this.requestTimeoutMs = requestTimeoutMs;
    this.armedGateVerifier = armedGateVerifier;
    this.projectionBaselines = projectionBaselines;
  }

  assertAllowedRef(ref) { return parseAllowedRef(ref, this.sheetIds); }

  async token() { return this.tokenProvider ? await this.tokenProvider() : this.accessToken; }

  async request(url, options = {}) {
    const bearer = await this.token();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try { response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    }); } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') { const timed = new Error('Sheets API timeout'); timed.code = 'ETIMEDOUT'; throw timed; }
      throw error;
    } finally { clearTimeout(timeout); }
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`Sheets API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body ? JSON.parse(body) : {};
  }

  async precheck() {
    const fields = 'properties(title,locale,timeZone),sheets.properties(sheetId,title,gridProperties)';
    const metadata = await this.request(`${this.base}?fields=${encodeURIComponent(fields)}`);
    this.sheetIds = Object.fromEntries((metadata.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
    for (const [title, policy] of Object.entries(SHEET_POLICY)) {
      if (this.sheetIds[title] !== policy.sheetId) throw new Error(`sheetId policy 不符：${title}`);
    }
    return metadata.properties;
  }

  async verifyArmedGates(requirements) {
    const result = this.armedGateVerifier ? await this.armedGateVerifier(requirements) : await this.verifyProjectionBaselines(requirements);
    if (!result?.verified || result.liveSwitch !== requirements.requiredLiveValue || !requirements.requiredProjections.every((id) => result.projections?.[id])) throw new Error('projection/LIVE gate 證據不足');
    return result;
  }

  async verifyBackupGate(requirements) {
    if (requirements.expectedBackupFileId !== BACKUP_FILE_ID || requirements.backup_file_id !== BACKUP_FILE_ID) throw new Error('BACKUP_FILE_ID_MISMATCH');
    if (requirements.expectedSourceSheetId !== this.spreadsheetId || requirements.source_sheet_id !== this.spreadsheetId) throw new Error('BACKUP_SOURCE_SHEET_MISMATCH');
    const fields = 'id,name,mimeType,createdTime,modifiedTime,size,trashed';
    const metadata = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(BACKUP_FILE_ID)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`);
    if (metadata.id !== BACKUP_FILE_ID || metadata.trashed) throw new Error('BACKUP_DRIVE_FILE_UNAVAILABLE');
    if (metadata.mimeType !== 'application/vnd.google-apps.spreadsheet') throw new Error('BACKUP_MIME_TYPE_INVALID');
    if (metadata.name !== requirements.title) throw new Error('BACKUP_TITLE_MISMATCH');
    if (!metadata.name.includes(`source-${this.spreadsheetId}`)) throw new Error('BACKUP_SOURCE_PROVENANCE_MISSING');
    if (metadata.createdTime !== requirements.created_at) throw new Error('BACKUP_CREATED_AT_MISMATCH');
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size !== requirements.size) throw new Error('BACKUP_SIZE_MISMATCH');
    const liveSha = hash([metadata.id, this.spreadsheetId, metadata.createdTime, metadata.name, size]);
    if (liveSha !== requirements.sha) throw new Error('BACKUP_SHA_MISMATCH');
    return { verified: true, id: metadata.id, title: metadata.name, sourceSheetId: this.spreadsheetId, mimeType: metadata.mimeType, createdAt: metadata.createdTime, size, sha: liveSha };
  }

  async values(range) {
    const response = await this.request(`${this.base}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return response.values || [];
  }
  async authoritativeMatchRows() {
    const plan = fullPlan();
    const canonicalRows = canonicalScheduleRows();
    if (plan.length !== 310 || new Set(plan.map((match) => match.id)).size !== 310
      || new Set(plan.map((match) => match.no)).size !== 310) {
      throw new Error('AUTHORITATIVE_LOCAL_PLAN_NOT_UNIQUE');
    }
    const allNos = plan.map((match) => match.no).sort((a, b) => a - b);
    if (allNos.some((no, index) => no !== index + 1)) throw new Error('AUTHORITATIVE_LOCAL_PLAN_NOT_COMPLETE');
    const specs = [
      { key: 'qualification', prefix: 'qual', range: '2_資格賽成績!A2:A151', expected: 150, columns: { score: ['K', 'L'], names: [] } },
      { key: 'knockout', prefix: 'knockout', range: '4_淘汰賽成績!A2:A133', expected: 132, columns: { score: ['M', 'N'], names: ['J', 'L'] } },
      { key: 'invitational', prefix: 'invitational', range: '5_曜請成績!A2:A29', expected: 28, columns: { score: ['J', 'K'], names: [] } }
    ];
    const result = {};
    for (const spec of specs) {
      const matches = plan.filter((match) => match.stage === spec.key);
      if (matches.length !== spec.expected) throw new Error(`AUTHORITATIVE_LOCAL_PLAN_COUNT:${spec.key}:${matches.length}/${spec.expected}`);
      if (JSON.stringify(matches.map((match) => match.no)) !== JSON.stringify(canonicalRows[spec.key])) {
        throw new Error(`AUTHORITATIVE_LOCAL_PLAN_SCHEDULE_MISMATCH:${spec.key}`);
      }
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index]; const row = index + 2;
        const expectedId = `${spec.prefix}-${index + 1}`;
        const expectedNameCells = spec.columns.names.map((column) => `${spec.range.slice(0, spec.range.indexOf('!'))}!${column}${row}`);
        const expectedScoreCells = spec.columns.score.map((column) => `${spec.range.slice(0, spec.range.indexOf('!'))}!${column}${row}`);
        const expectedCells = [...expectedNameCells, ...expectedScoreCells];
        if (match.id !== expectedId || JSON.stringify(match.nameCells || []) !== JSON.stringify(expectedNameCells)
          || JSON.stringify(match.scoreCells) !== JSON.stringify(expectedScoreCells)
          || JSON.stringify(match.cells) !== JSON.stringify(expectedCells)) {
          throw new Error(`AUTHORITATIVE_LOCAL_PLAN_CELLS:${spec.key}:row=${row}:match=${match.id}`);
        }
      }
      const rows = await this.values(spec.range);
      const ids = rows.map((row) => Number(row?.[0]));
      if (new Set(ids).size !== ids.length) throw new Error(`AUTHORITATIVE_MATCH_ROW_DUPLICATE:${spec.key}`);
      if (rows.length !== spec.expected || ids.some((id, index) => !Number.isInteger(id) || id !== canonicalRows[spec.key][index])) {
        const bad = ids.findIndex((id, index) => !Number.isInteger(id) || id !== canonicalRows[spec.key][index]);
        const index = bad < 0 ? rows.length : bad;
        throw new Error(`AUTHORITATIVE_MATCH_ROW_MAPPING:${spec.key}:row=${index + 2}:actual=${bad < 0 ? 'missing' : ids[index]}:expected=${canonicalRows[spec.key][index] ?? 'none'}`);
      }
      result[spec.key] = ids;
    }
    // 顯式讀取權威賽程設定，確保不是從比分欄推導 last row。欄位名稱由現場表
    // 決定，這裡只用於存在性／非空稽核，場次 ID 仍以上述三張成績表為準。
    const schedule = await this.values('0_賽事設定!A1:Z400');
    if (!schedule.length) throw new Error('AUTHORITATIVE_SCHEDULE_EMPTY');
    return result;
  }
  async verifyProjectionBaselines(requirements) {
    if (!this.projectionBaselines) throw new Error('缺少 projection hash baselines');
    const live = await this.values(requirements.liveCell);
    const liveSwitch = live?.[0]?.[0]; const projections = {};
    for (const id of requirements.requiredProjections) {
      const baseline = this.projectionBaselines[id]; if (typeof baseline !== 'string') throw new Error(`缺少 projection ${id} baseline`);
      projections[id] = hash(canonicalProjectionValues(id, await this.values(PROJECTION_RANGES[id])));
      if (projections[id] !== baseline) throw projectionHashMismatch(id, projections[id], baseline);
    }
    return { verified: true, liveSwitch, projections };
  }

  async readCells(refs) {
    const out = {};
    const bySheet = new Map();
    for (const ref of refs) {
      this.assertAllowedRef(ref);
      const sheet = ref.slice(0, ref.lastIndexOf('!'));
      if (!bySheet.has(sheet)) bySheet.set(sheet, []);
      bySheet.get(sheet).push(ref);
    }
    for (const sheetRefs of bySheet.values()) {
      for (let start = 0; start < sheetRefs.length; start += 50) {
        const batch = sheetRefs.slice(start, start + 50);
        const params = new URLSearchParams({ includeGridData: 'true', fields: 'sheets(properties(title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation,note))))' });
        batch.forEach((ref) => params.append('ranges', ref));
        const data = await this.request(`${this.base}?${params}`);
        const blocks = (data.sheets || []).flatMap((sheet) => sheet.data || []);
        for (let i = 0; i < batch.length; i += 1) out[batch[i]] = clone(blocks[i]?.rowData?.[0]?.values?.[0] || null);
      }
    }
    return out;
  }

  async writeCells(values) {
    const requests = Object.entries(values).map(([a1, cell]) => ({
      updateCells: {
        range: this.assertAllowedRef(a1),
        rows: [{ values: [cell?.userEnteredValue ? { userEnteredValue: cell.userEnteredValue } : {}] }],
        fields: 'userEnteredValue'
      }
    }));
    await this.request(`${this.base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  }
  async clearCells(refs) {
    const requests = refs.map((a1) => ({ repeatCell: { range: this.assertAllowedRef(a1), cell: {}, fields: 'userEnteredValue' } }));
    await this.request(`${this.base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  }
}

function parseAllowedRef(a1, observedSheetIds = {}) {
  const match = a1.match(/^'?(.+?)'?!([A-Z]+)(\d+)$/u);
  if (!match) throw new Error(`只允許單格 A1 寫入：${a1}`);
  const [, title, column, rowText] = match;
  const policy = SHEET_POLICY[title];
  const row = Number(rowText);
  if (!policy || !policy.columns.has(column) || row < policy.rows[0] || row > policy.rows[1]) {
    throw new Error(`GridRange allowlist 拒絕：${a1}`);
  }
  if (Object.keys(observedSheetIds).length && observedSheetIds[title] !== policy.sheetId) {
    throw new Error(`sheetId policy 不符：${title}`);
  }
  const col = [...column].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
  return { sheetId: policy.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 };
}

module.exports = {
  SheetsRestAdapter, SPREADSHEET_ID, BACKUP_FILE_ID, SHEET_POLICY,
  PROJECTION_RANGES, PROJECTION_SHAPES, canonicalProjectionValues, canonicalScheduleRows, parseAllowedRef
};
