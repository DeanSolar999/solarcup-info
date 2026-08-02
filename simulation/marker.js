#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hash, safeError } = require('./lib');

const RUN_ID = /^[a-zA-Z][a-zA-Z0-9_-]{1,80}$/;
const TYPES = new Set(['observer-heartbeat', 'canary-observed', 'canary-approved']);
const ROOT = path.resolve(__dirname, 'runs');

function args(argv) {
  const [type, ...rest] = argv; const out = { type };
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || !rest[i + 1]) throw new Error('marker 參數不完整');
    out[rest[i].slice(2).replaceAll('-', '_')] = rest[i + 1];
  }
  return out;
}

function assertRealDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MARKER_UNSAFE_DIRECTORY');
  return { real: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino };
}

function assertRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MARKER_UNSAFE_FILE');
}

function readRegularJson(file) {
  assertRegular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('MARKER_UNSAFE_FILE');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

function writeMarker(directory, file, value) {
  const before = assertRealDirectory(directory);
  if (fs.existsSync(file)) assertRegular(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const afterWrite = assertRealDirectory(directory);
  if (before.dev !== afterWrite.dev || before.ino !== afterWrite.ino) throw new Error('MARKER_PARENT_CHANGED');
  fs.renameSync(temporary, file);
  const afterRename = assertRealDirectory(directory);
  if (before.dev !== afterRename.dev || before.ino !== afterRename.ino) throw new Error('MARKER_PARENT_CHANGED');
  const directoryFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function main(argv = process.argv.slice(2), { root: injectedRoot = ROOT } = {}) {
  const o = args(argv);
  if (!TYPES.has(o.type) || !RUN_ID.test(o.run_id || '')) throw new Error('非法 marker type/run_id');
  const fixedRoot = path.resolve(injectedRoot);
  if (o.state_dir && path.resolve(o.state_dir) !== fixedRoot) throw new Error('armed marker 僅允許固定 state root');
  fs.mkdirSync(fixedRoot, { recursive: true, mode: 0o700 });
  // Do not chmod until lstat/realpath has proven this is not a symlink.
  const root = assertRealDirectory(fixedRoot); fs.chmodSync(root.real, 0o700); assertRealDirectory(root.real);
  const runDirectory = path.join(root.real, o.run_id);
  const run = assertRealDirectory(runDirectory);
  if (!run.real.startsWith(`${root.real}${path.sep}`)) throw new Error('MARKER_UNSAFE_RUN_DIRECTORY');
  const manifestPath = path.join(run.real, 'manifest.json');
  const manifest = readRegularJson(manifestPath);
  const manifestHash = hash({ schema: manifest.schema, run_id: manifest.run_id, allowlist: manifest.allowlist, pre_canonical_hash: manifest.pre_canonical_hash });
  if (o.manifest_hash !== manifestHash || !o.fencing_token) throw new Error('manifest hash 或 fencing token 不符');
  const ttl = Number(o.ttl_seconds || 60);
  if (!Number.isInteger(ttl) || ttl < 10 || ttl > 300) throw new Error('ttl-seconds 必須介於 10–300');
  const markers = path.join(root.real, 'markers'); fs.mkdirSync(markers, { recursive: true, mode: 0o700 });
  const markerDirectory = assertRealDirectory(markers); fs.chmodSync(markerDirectory.real, 0o700); assertRealDirectory(markerDirectory.real);
  if (!markerDirectory.real.startsWith(`${root.real}${path.sep}`)) throw new Error('MARKER_UNSAFE_DIRECTORY');
  writeMarker(markerDirectory.real, path.join(markerDirectory.real, `${o.run_id}.${o.type}.json`), {
    run_id: o.run_id, fencing_token: o.fencing_token, manifest_hash: manifestHash,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttl * 1000).toISOString()
  });
}

if (require.main === module) { try { main(); } catch (error) { console.error(safeError(error)); process.exitCode = 2; } }
module.exports = { main, args, ROOT, writeMarker, readRegularJson };
