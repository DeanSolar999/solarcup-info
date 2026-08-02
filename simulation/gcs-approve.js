#!/usr/bin/env node
'use strict';
const { GcsJsonClient } = require('./gcs-generation-lease');
const { GcsApprovalStore } = require('./gcs-run-state');
const RUN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{1,72}$/;
async function main() {
  const runId = process.env.SOLAR_CUP_BASE_RUN_ID;
  if (!RUN_ID.test(runId || '')) throw new Error('BASE_RUN_ID_INVALID');
  const client = new GcsJsonClient({ accessToken: process.env.GOOGLE_ACCESS_TOKEN });
  await new GcsApprovalStore({ client, bucket: process.env.SOLAR_CUP_GCS_BUCKET, prefix: 'solarcup-simulation/runs' }).approve(runId);
}
if (require.main === module) main().catch((e) => { console.error(e.code || e.message); process.exitCode = 2; });
module.exports = { main, RUN_ID };
