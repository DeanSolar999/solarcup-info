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
