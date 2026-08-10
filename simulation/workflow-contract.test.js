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
  const baselines = '{"3":"4bea314d53dfb638f7cfac92332845afba333d0c9763f32fc2e8afda3e61b781","6":"087553ad9eebfba8f31408834ae6734221ba64a7c7575008a069b888755196e4","7":"81137b66f236cd4f84fed2bab3436b40426dd2a94dd8e6191d557f66b8f7417a","8":"b97a98625dc411b1876cfcb1145231f2a35f862436da8d62b114f94eb9fa7a55"}';
  const staleBaselines = [
    '23ec2261d059f04eba310a5499654518f562466656d4ea3583b5056f81a47da4',
    'c6b6cda611f9968534acf4da40aeee774f7ae865765ce365061aab1d0199b920',
    '759bf4f7d6a86f17a75f77ea92a5b9199193c4e80ecc3b2eefc9cf2c7a378fca',
    'bd054c98dea579c2e3f73e834f1f0a6ce7c69394d074b2bd918c9c75fc042b4a'
  ];
  assert.equal((workflow.match(/Build fresh backup evidence for /g) || []).length, 7);
  assert.equal((workflow.match(/SOLAR_CUP_BACKUP_EVIDENCE=/g) || []).length, 7);
  assert.equal((workflow.match(/verified_at:new Date\(\)\.toISOString\(\)/g) || []).length, 7);
  assert.equal((workflow.match(/JSON\.stringify\(\[e\.backup_file_id,e\.source_sheet_id,e\.created_at,e\.title,e\.size\]\)/g) || []).length, 7);
  assert.match(workflow, /source-1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA/);
  assert.match(workflow, /SOLAR_CUP_BACKUP_SIZE: '76499'/);
  assert.doesNotMatch(workflow, /secrets\.SOLAR_CUP_PROJECTION_BASELINES/);
  assert.equal((workflow.match(/SOLAR_CUP_PROJECTION_BASELINES:/g) || []).length, 3, 'preflight、simulate 與 recovery job-level 各一份');
  assert.equal(workflow.split(`SOLAR_CUP_PROJECTION_BASELINES: '${baselines}'`).length - 1, 3);
  for (const stale of staleBaselines) assert.doesNotMatch(workflow, new RegExp(stale), `stale short-row baseline ${stale.slice(0, 8)}`);
  assert.match(workflow, /preflight:[\s\S]*?--preflight-only --run-id/);
  assert.match(workflow, /simulate:\n\s+needs: preflight\n\s+if: needs\.preflight\.result == 'success' && inputs\.preflight_only == false/);
  for (const segment of [1, 2, 3, 4, 5]) assert.match(workflow, new RegExp(`Build fresh backup evidence for segment ${segment}[\\s\\S]*?--segment ${segment}`));
  assert.match(workflow, /Build fresh backup evidence for recovery[\s\S]*?restore-only --armed/);
});

test('autonomous preflight_only：true 僅跑唯讀 preflight，false 維持 full 與失敗 recovery', () => {
  const workflow = read('autonomous-simulate.yml');
  assert.match(workflow, /preflight_only:\n\s+description: Run read-only production preflight without simulation or recovery\n\s+required: false\n\s+default: false\n\s+type: boolean/);
  const simulateIf = workflow.match(/  simulate:\n\s+needs: preflight\n\s+if: ([^\n]+)/)?.[1] || '';
  const recoveryIf = workflow.match(/  recovery:\n\s+if: ([^\n]+)/)?.[1] || '';
  assert.match(simulateIf, /needs\.preflight\.result == 'success'/, 'false 仍須接續成功 preflight');
  assert.match(simulateIf, /inputs\.preflight_only == false/, 'true 不得啟動 simulate');
  assert.match(recoveryIf, /inputs\.preflight_only == false/, 'true 不得啟動 recovery');
  assert.match(recoveryIf, /needs\.simulate\.result == 'failure'/, 'false 保留失敗 recovery');
  assert.match(recoveryIf, /needs\.simulate\.result == 'cancelled'/, 'false 保留取消 recovery');
  const simulateDecision = (preflightOnly, preflightResult) => preflightOnly === false && preflightResult === 'success';
  const recoveryDecision = (preflightOnly, simulateResult) => preflightOnly === false && ['failure', 'cancelled'].includes(simulateResult);
  assert.equal(simulateDecision(true, 'success'), false); assert.equal(recoveryDecision(true, 'failure'), false);
  assert.equal(simulateDecision(false, 'success'), true); assert.equal(recoveryDecision(false, 'failure'), true);
});
