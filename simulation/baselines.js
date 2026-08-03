'use strict';

/* 算出 armed 模式要求的 projection baselines（4 個 SHA-256）
   ────────────────────────────────────────────────────────────
   baseline 的用途是「開跑前把試算表的預期狀態釘住」——runner 在 segment 1
   寫入任何一格之前會重算並比對，不符就 fail-closed。
   所以它必須是事先算好、人工帶入的固定值；runner 自己在開跑當下現算就失去意義
   （偵測不到「開跑前就已經被別人動過」）。

   用法：node baselines.js
   輸出可直接餵給 SOLAR_CUP_PROJECTION_BASELINES。 */

const { accessToken } = require('./sa-token');
const { SheetsRestAdapter, SPREADSHEET_ID, PROJECTION_RANGES } = require('./sheets-rest-adapter');
const { hash } = require('./lib');

async function main() {
  const { token, clientEmail } = await accessToken();
  const adapter = new SheetsRestAdapter({ spreadsheetId: SPREADSHEET_ID, accessToken: token });
  const properties = await adapter.precheck();
  console.error(`· identity   ${clientEmail}`);
  console.error(`· 活頁簿     ${properties.title}`);
  console.error(`· 時區       ${properties.timeZone}`);
  if (properties.timeZone !== 'Asia/Taipei') console.error('  ⚠️ 時區不是 Asia/Taipei');

  const live = await adapter.values('0_賽事設定!B12');
  console.error(`· LIVE 開關  B12 = ${JSON.stringify(live?.[0]?.[0])}（0＝示範，armed gate 要求 0）`);

  const out = {};
  for (const [id, range] of Object.entries(PROJECTION_RANGES)) {
    const values = await adapter.values(range);
    out[id] = hash(values);
    console.error(`· projection ${id}  ${range}  ${values.length} 列  ${out[id].slice(0, 16)}…`);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((error) => { console.error('❌', error.message); process.exit(1); });
