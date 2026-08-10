'use strict';

const { clone } = require('./lib');

class MockAdapter {
  constructor(initial = {}, options = {}) {
    this.cells = new Map(Object.entries(clone(initial)));
    this.options = options;
    this.writeCount = 0;
  }

  async precheck() { return { title: 'mock', locale: 'zh_TW', timeZone: 'Asia/Taipei' }; }
  async verifyArmedGates(requirements) {
    if (!this.options.armedGateResult) throw new Error('缺少 projection/LIVE gate evidence verifier');
    return typeof this.options.armedGateResult === 'function' ? this.options.armedGateResult(requirements) : this.options.armedGateResult;
  }
  async verifyBackupGate(requirements) {
    if (this.options.backupGateError) throw this.options.backupGateError;
    return this.options.backupGateResult || { verified: true, id: requirements.backup_file_id, title: requirements.title, sourceSheetId: requirements.source_sheet_id };
  }
  async authoritativeMatchRows() {
    if (!this.options.authoritativeRows) throw new Error('AUTHORITATIVE_MATCH_PREFLIGHT_UNAVAILABLE');
    return this.options.authoritativeRows;
  }

  async readCells(refs) {
    return Object.fromEntries(refs.map((ref) => [ref, clone(this.cells.get(ref) ?? null)]));
  }

  async writeCells(values) {
    this.writeCount += 1;
    Object.entries(values).forEach(([ref, value]) => this.cells.set(ref, clone(value)));
    if (this.options.timeoutAfterWriteOnce && this.writeCount === 1) {
      const error = new Error('simulated API timeout after accepted write');
      error.code = 'ETIMEDOUT';
      throw error;
    }
  }
  async clearCells(refs) { refs.forEach((ref) => this.cells.set(ref, null)); }

  mutate(ref, value) { this.cells.set(ref, clone(value)); }
}

module.exports = { MockAdapter };
