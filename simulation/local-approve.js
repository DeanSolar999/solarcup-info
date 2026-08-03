'use strict';

/* 本機版 canary 核准（對應 gcs-approve.js）
   只能依既有的 canary-report 建立一次；同一 run 第二次執行會被拒絕，不覆寫舊核准。
   用法：node local-approve.js <state-dir> <run-id> */

const { LocalApprovalStore } = require('./local-state');
const { safeError } = require('./lib');

const [dir, runId] = process.argv.slice(2);
if (!dir || !runId) { console.error('用法：node local-approve.js <state-dir> <run-id>'); process.exit(2); }

new LocalApprovalStore({ dir }).approve(runId)
  .then((a) => console.log(JSON.stringify(a, null, 2)))
  .catch((error) => { console.error('❌', safeError(error)); process.exit(2); });
