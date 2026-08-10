'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const test = require('node:test');
const root = path.join(__dirname, '..', '.github', 'workflows'); const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
test('五 workflow contract：無 phase、無 inherit、固定 regex 與 production lock', () => {
  assert.equal(fs.existsSync(path.join(root, 'phase.yml')), false);
  for (const f of ['dry-run.yml','canary.yml','approve-canary.yml','simulate.yml','restore.yml']) { const y=read(f); assert.doesNotMatch(y,/--phase|secrets:\s*inherit/); assert.match(y,/workflow_dispatch/); }
  for (const f of ['dry-run.yml','canary.yml','simulate.yml','restore.yml']) assert.match(read(f),/\^\[A-Za-z\]\[A-Za-z0-9_-\]\{1,72\}\$/);
  for (const f of ['canary.yml','approve-canary.yml','simulate.yml','restore.yml']) assert.match(read(f),/permissions: \{ contents: read, id-token: write \}/);
  assert.match(read('simulate.yml'),/needs\.resume\.result == 'failure'.*cancelled/s); assert.match(read('simulate.yml'),/restore-only --armed/);
  const simulate = read('simulate.yml');
  assert.equal((simulate.match(/google-github-actions\/auth@71f986410dfbc7added4569d411d040a91dc6935/g) || []).length, 6);
  for (const segment of [1, 2, 3, 4, 5]) assert.match(simulate, new RegExp(`--segment ${segment} --run-id`));
  assert.doesNotMatch(simulate, /<<:\s*\*/); assert.match(simulate, /create_credentials_file: false/);
});

test('autonomous workflow：preflight、五段與 recovery 都在 runtime 建立 canonical backup evidence', () => {
  const workflow = read('autonomous-simulate.yml');
  const baselines = '{"3":"23ec2261d059f04eba310a5499654518f562466656d4ea3583b5056f81a47da4","6":"c6b6cda611f9968534acf4da40aeee774f7ae865765ce365061aab1d0199b920","7":"759bf4f7d6a86f17a75f77ea92a5b9199193c4e80ecc3b2eefc9cf2c7a378fca","8":"bd054c98dea579c2e3f73e834f1f0a6ce7c69394d074b2bd918c9c75fc042b4a"}';
  assert.equal((workflow.match(/Build fresh backup evidence for /g) || []).length, 7);
  assert.equal((workflow.match(/SOLAR_CUP_BACKUP_EVIDENCE=/g) || []).length, 7);
  assert.equal((workflow.match(/verified_at:new Date\(\)\.toISOString\(\)/g) || []).length, 7);
  assert.equal((workflow.match(/JSON\.stringify\(\[e\.backup_file_id,e\.source_sheet_id,e\.created_at,e\.title,e\.size\]\)/g) || []).length, 7);
  assert.match(workflow, /source-1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA/);
  assert.match(workflow, /SOLAR_CUP_BACKUP_SIZE: '76499'/);
  assert.doesNotMatch(workflow, /secrets\.SOLAR_CUP_PROJECTION_BASELINES/);
  assert.equal((workflow.match(/SOLAR_CUP_PROJECTION_BASELINES:/g) || []).length, 3, 'preflight、simulate 與 recovery job-level 各一份');
  assert.equal(workflow.split(`SOLAR_CUP_PROJECTION_BASELINES: '${baselines}'`).length - 1, 3);
  assert.match(workflow, /preflight:[\s\S]*?--preflight-only --run-id/);
  assert.match(workflow, /simulate:\n\s+needs: preflight\n\s+if: needs\.preflight\.result == 'success'/);
  for (const segment of [1, 2, 3, 4, 5]) assert.match(workflow, new RegExp(`Build fresh backup evidence for segment ${segment}[\\s\\S]*?--segment ${segment}`));
  assert.match(workflow, /Build fresh backup evidence for recovery[\s\S]*?restore-only --armed/);
});
