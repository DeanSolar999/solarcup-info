'use strict';

const { hash, canonicalCells } = require('./lib');

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function evidenceEntries(manifest) {
  const raw = manifest.assertion_evidence || manifest.assertions || manifest.evidence?.assertions || [];
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([eventId, value]) => ({ eventId, ...(value || {}) }));
}

function evidenceStatus(evidence) {
  const status = String(evidence?.status || '').toLowerCase();
  if (['pass', 'passed', 'ok'].includes(status) || evidence?.passed === true) return 'pass';
  if (['fail', 'failed', 'error'].includes(status) || evidence?.passed === false) return 'fail';
  return 'skipped';
}

function scenarioResults(manifest) {
  const byEvent = new Map(evidenceEntries(manifest).map((item) => [item.eventId || item.matchId || item.id, item]));
  const result = {};
  for (const match of manifest.plan || []) {
    const scenario = match.scenario;
    if (!/^[A-K]$/.test(scenario || '')) continue;
    const bucket = result[scenario] ||= {
      pass: 0, fail: 0, skipped: 0,
      assertions: (match.steps || []).map((step) => step.assertion || step.type), evidence: []
    };
    const evidence = byEvent.get(match.id);
    const status = evidenceStatus(evidence);
    bucket[status] += 1;
    bucket.evidence.push(evidence ? { eventId: match.id, status, source: evidence.source || 'manifest.assertion_evidence' } : { eventId: match.id, status: 'skipped', source: 'missing_assertion_evidence' });
  }
  return result;
}

function normalizedFindings(items) {
  return items.map((item) => ({
    code: item.code || 'INFO', severity: item.severity || 'info', eventId: item.eventId || null,
    at: item.at || null, latencyMs: Number.isFinite(item.latencyMs) ? item.latencyMs : null,
    sites: item.sites || null
  }));
}

function reportPayload({ manifest, findings = [], observerFindings = [], startedAt, finishedAt }) {
  const allFindings = normalizedFindings([...findings, ...observerFindings]);
  const visible = allFindings.filter((item) => item.code === 'OBSERVER_EVENT_VISIBLE' && Number.isFinite(item.latencyMs));
  // 相同 event 的多個 site 觀測只保留最慢一次，代表整條 stage route 同步完成時間。
  const byEvent = new Map();
  for (const item of visible) byEvent.set(item.eventId, Math.max(byEvent.get(item.eventId) || 0, item.latencyMs));
  const latencies = [...byEvent.values()];
  const restoreHash = manifest.restore_evidence?.final_canonical_hash || manifest.restore_readback?.canonical_hash || null;
  const restoreVerified = Boolean(restoreHash && restoreHash === manifest.pre_canonical_hash);
  return {
    schema: 2, runId: manifest.run_id, startedAt, finishedAt, state: manifest.state,
    preImageHash: manifest.pre_canonical_hash, postImageHash: hash(manifest.post_image || {}),
    completed: manifest.checkpoint?.completed?.length || 0,
    scenarios: scenarioResults(manifest),
    findings: allFindings,
    backendReadback: Object.keys(manifest.readback_evidence?.writes || {}).length,
    restore: {
      state: manifest.state, reason: manifest.reason || null, preImageHash: manifest.pre_canonical_hash,
      finalReadbackHash: restoreHash, verified: restoreVerified,
      evidence: restoreHash ? 'restore_final_readback' : 'missing_restore_final_readback'
    },
    syncLatencyMs: { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
    bugs: allFindings.filter((item) => item.severity !== 'info').length,
    redacted: true
  };
}

function markdown(payload) {
  const findings = payload.findings.length ? payload.findings.map((item) => `- ${item.severity}｜${item.code}${item.eventId ? `｜${item.eventId}` : ''}`).join('\n') : '- 無';
  const scenarios = Object.entries(payload.scenarios).map(([key, value]) => `- ${key}：pass ${value.pass}／fail ${value.fail}／skipped ${value.skipped}`).join('\n') || '- 無場景證據';
  const latency = payload.syncLatencyMs.samples ? `p50 ${payload.syncLatencyMs.p50} ms／p95 ${payload.syncLatencyMs.p95} ms／max ${payload.syncLatencyMs.max} ms` : '無可用同步延遲樣本';
  return `# 曜日盃 TWO 模擬報告\n\n- Run：${payload.runId}\n- 狀態：${payload.state}\n- 完成場次：${payload.completed}\n- Pre-image hash：${payload.preImageHash}\n- Restore：${payload.restore.verified ? '已由最終讀回 hash 驗證' : `未驗證（${payload.restore.evidence}）`}\n\n## 場景\n\n${scenarios}\n\n## 前端同步延遲\n\n${latency}\n\n## Findings\n\n${findings}\n`;
}

module.exports = { reportPayload, markdown, percentile, scenarioResults };
