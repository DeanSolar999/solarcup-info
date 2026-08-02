'use strict';

const { clone, hash } = require('./lib');

const SPREADSHEET_ID = '1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
const SHEET_POLICY = Object.freeze({
  '2_資格賽成績': { sheetId: 252930776, rows: [2, 151], columns: new Set(['K', 'L']) },
  '4_淘汰賽成績': { sheetId: 1125219206, rows: [2, 133], columns: new Set(['M', 'N']) },
  '5_曜請成績': { sheetId: 848445550, rows: [2, 29], columns: new Set(['J', 'K']) }
});
const PROJECTION_RANGES = Object.freeze({
  '3': '3_資格賽積分榜!A1:Z109', '6': '6_積分總表!A1:Z109',
  '7': '7_球團積分!A1:Z11', '8': '8_發布_戰情看板!A1:Z311'
});

class SheetsRestAdapter {
  constructor({ spreadsheetId, accessToken, requestTimeoutMs = 10_000, armedGateVerifier = null, projectionBaselines = null }) {
    if (spreadsheetId !== SPREADSHEET_ID) throw new Error('Spreadsheet allowlist 不符');
    if (!accessToken) throw new Error('缺少 GOOGLE_ACCESS_TOKEN');
    this.spreadsheetId = spreadsheetId;
    this.accessToken = accessToken;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
    this.sheetIds = {};
    this.requestTimeoutMs = requestTimeoutMs;
    this.armedGateVerifier = armedGateVerifier;
    this.projectionBaselines = projectionBaselines;
  }

  assertAllowedRef(ref) { return parseAllowedRef(ref, this.sheetIds); }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try { response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
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

  async values(range) {
    const response = await this.request(`${this.base}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return response.values || [];
  }
  async verifyProjectionBaselines(requirements) {
    if (!this.projectionBaselines) throw new Error('缺少 projection hash baselines');
    const live = await this.values(requirements.liveCell);
    const liveSwitch = live?.[0]?.[0]; const projections = {};
    for (const id of requirements.requiredProjections) {
      const baseline = this.projectionBaselines[id]; if (typeof baseline !== 'string') throw new Error(`缺少 projection ${id} baseline`);
      projections[id] = hash(await this.values(PROJECTION_RANGES[id])); if (projections[id] !== baseline) throw new Error(`projection ${id} hash 不符`);
    }
    return { verified: true, liveSwitch, projections };
  }

  async readCells(refs) {
    refs.forEach((ref) => this.assertAllowedRef(ref));
    const params = new URLSearchParams({ includeGridData: 'true', fields: 'sheets(properties(title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation,note))))' });
    refs.forEach((ref) => params.append('ranges', ref));
    const data = await this.request(`${this.base}?${params}`);
    const blocks = (data.sheets || []).flatMap((sheet) => sheet.data || []);
    const out = {};
    for (let i = 0; i < refs.length; i += 1) out[refs[i]] = clone(blocks[i]?.rowData?.[0]?.values?.[0] || null);
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

module.exports = { SheetsRestAdapter, SPREADSHEET_ID, SHEET_POLICY, PROJECTION_RANGES, parseAllowedRef };
