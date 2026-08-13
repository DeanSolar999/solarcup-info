'use strict';

/* 淘汰賽參賽隊伍解析器
   ────────────────────────────────────────────────────────────
   ⚠️ 角色收斂＝純驗證（2026-08-13 銜接校準完成，禁令解除）：
   bracket-tree 已雲端化（playM 只讀雲端、隊名空＝待定、季殿＝雲端
   #third 列），且初賽配對＝現場抽籤（2026-08-12 團長定案）——
   對戰組合不再有任何推導空間。本檔今後只做驗證：
     · O 欄勝方 vs 比分（BACKEND_WINNER_MISMATCH／EMPTY finding）
     · 雲端隊名合法性（名冊反查，ROSTER_* finding）
   namesFor() 的結構推導路徑（經 bracket.js deriveAll／deprecated
   seedsFor）僅為既有測試相容而保留，禁用於產生入座——重放驗證
   一律走 site-engine.replayVerify()。ScriptedResolver（照劇本）不受影響。
   ────────────────────────────────────────────────────────────
   每寫一場淘汰賽之前，先回頭問雲端「到目前為止誰贏了」，再據以決定這一場誰上場。
   刻意讀 `4_淘汰賽成績` O 欄（勝方）而不是自己拿分數比大小——O 欄是後端公式
   `IF(M>N,I,K)` 算出來的，用它往下推才是在驗後端，否則只是腳本自己跟自己對答案。

   O 欄回傳的是隊伍編號，要靠 `1_隊伍名冊` 換回隊名；換不到就是後端的編號反查斷了，
   屬於要記錄的 finding。 */

const { loadTopology, deriveAll, seedsFor, TIER_KEYS } = require('./bracket');

const QUAL_RANGE = '3_資格賽積分榜!A2:K101';
const KNOCK_RANGE = '4_淘汰賽成績!A2:O133';
const ROSTER_RANGE = '1_隊伍名冊!A2:D109';

function text(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function int(v) { const n = parseInt(text(v), 10); return Number.isInteger(n) ? n : null; }

// ── 雲端來源：armed 模式用 ────────────────────────────────────
class CloudSource {
  constructor(adapter) { this.adapter = adapter; this._roster = null; }

  async roster() {
    if (this._roster) return this._roster;
    const rows = await this.adapter.values(ROSTER_RANGE);
    const byNo = new Map(); const names = new Set();
    rows.forEach((r) => {
      const no = int(r?.[0]); const name = text(r?.[3]);
      if (no !== null && name) { byNo.set(no, name); names.add(name); }
    });
    if (byNo.size !== 108) throw new Error(`ROSTER_SIZE:${byNo.size}/108`);
    this._roster = { byNo, names };
    return this._roster;
  }

  async qualRows() {
    const rows = await this.adapter.values(QUAL_RANGE);
    return rows.map((r) => ({
      no: int(r?.[0]), name: text(r?.[1]), rank: int(r?.[9]), tier: text(r?.[10])
    })).filter((r) => r.no !== null && r.name);
  }

  async knockRows() {
    const { byNo } = await this.roster();
    const rows = await this.adapter.values(KNOCK_RANGE);
    const out = {};
    rows.forEach((r) => {
      const no = int(r?.[0]);
      if (no === null) return;
      const a = text(r?.[9]); const b = text(r?.[11]);
      const sa = int(r?.[12]); const sb = int(r?.[13]);
      const winnerNo = int(r?.[14]);              // O 欄＝後端算出的勝方編號
      const winner = winnerNo === null ? '' : (byNo.get(winnerNo) || '');
      out[no] = { a, b, sa, sb, winner, winnerNo, rawWinner: text(r?.[14]) };
    });
    return out;
  }
}

// ── 解析器本體 ────────────────────────────────────────────────
class KnockoutResolver {
  constructor({ source, topology = null, onFinding = null } = {}) {
    this.source = source;
    this.topology = topology || loadTopology();
    this.onFinding = onFinding || (() => {});
    this._seeds = null;
  }

  finding(code, detail) { this.onFinding({ code, detail }); }

  async seeds() {
    if (this._seeds) return this._seeds;
    const rows = await this.source.qualRows();
    const graded = rows.filter((r) => r.tier && r.tier !== '曜請');
    if (graded.length !== 100) throw new Error(`QUAL_TIERS_INCOMPLETE:${graded.length}/100`);
    const seeds = {};
    for (const key of TIER_KEYS) seeds[key] = seedsFor(key, graded);
    this._seeds = seeds;
    return seeds;
  }

  async namesFor(match, adapter) {
    if (adapter && !this.source) this.source = new CloudSource(adapter);
    const seeds = await this.seeds();
    const results = await this.source.knockRows();

    // 後端 O 欄的勝方 vs 直接比分數：不一致就記錄，但不中斷（演練期間只記不改）
    Object.entries(results).forEach(([no, r]) => {
      if (r.sa === null || r.sb === null || !r.a || !r.b) return;
      const arithmetic = r.sa > r.sb ? r.a : r.b;
      if (!r.winner) this.finding('BACKEND_WINNER_EMPTY', `場次 ${no}：分數 ${r.sa}:${r.sb} 但 O 欄勝方為空（${r.rawWinner || '空'}）`);
      else if (r.winner !== arithmetic) this.finding('BACKEND_WINNER_MISMATCH', `場次 ${no}：O 欄判 ${r.winner}，比分 ${r.sa}:${r.sb} 應為 ${arithmetic}`);
    });

    const { pairs } = deriveAll(this.topology, seeds, results);
    const ab = pairs[match.no];
    if (!ab) {
      const known = Object.keys(results).filter((n) => results[n].winner).length;
      throw new Error(`UNRESOLVED_MATCH:${match.no}（已知勝方 ${known} 場，上一輪可能尚未完賽）`);
    }
    if (ab[0] === ab[1]) throw new Error(`SELF_MATCH:${match.no}=${ab[0]}`);
    return ab;
  }
}

/* 照劇本回答的解析器。
   dry-run 用它——mock adapter 背後沒有真的公式引擎，讀不到 O 欄勝方，
   所以 dry-run 只證明「寫入四格＋snapshot＋restore 的機制正確」，
   不宣稱證明晉級推導。推導的正確性由 offline-sim.js ＋ verify_offline.py
   在真公式上驗（見 README）。 */
class ScriptedResolver {
  constructor(pairs = {}) { this.pairs = pairs; }
  async namesFor(match) {
    const ab = this.pairs[match.no];
    if (ab) return ab;
    return [`模擬隊-${match.no}A`, `模擬隊-${match.no}B`];
  }
}

module.exports = { KnockoutResolver, CloudSource, ScriptedResolver, QUAL_RANGE, KNOCK_RANGE, ROSTER_RANGE };
