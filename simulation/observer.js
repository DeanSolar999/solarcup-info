'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const SITES = Object.freeze([
  { name: 'main-live', kind: 'live', url: 'https://deansolar999.github.io/solarcup-info/solar-cup-live.html' },
  { name: 'main-qualifying', kind: 'qualifying', url: 'https://deansolar999.github.io/solarcup-info/qualifying.html' },
  { name: 'main-bracket', kind: 'bracket', url: 'https://deansolar999.github.io/solarcup-info/bracket-tree.html' },
  { name: 'main-field', kind: 'field', url: 'https://deansolar999.github.io/solarcup-info/at-field-ranking.html' },
  // 預設戰情頁只列正在進行；剛完賽的 exact probe 固定使用 allowlist 的 recent 視圖。
  { name: 'mobile-battle', kind: 'mobile', url: 'https://deansolar999.github.io/solar-cup-two-live/?view=live&filter=recent' },
  { name: 'mobile-advance', kind: 'mobile', url: 'https://deansolar999.github.io/solar-cup-two-live/?view=advance' },
  { name: 'mobile-force', kind: 'mobile', url: 'https://deansolar999.github.io/solar-cup-two-live/?view=force' },
  { name: 'mobile-follow', kind: 'mobile', url: 'https://deansolar999.github.io/solar-cup-two-live/?view=follow' }
]);

const EVENT_ROUTES = Object.freeze({
  // qualifying/bracket 是階段健康頁（由 90 秒 sweep 檢查），不是每場都保證有對應 card。
  qualification: ['main-live', 'mobile-battle'],
  knockout: ['main-live', 'mobile-battle'],
  invitational: ['main-live', 'mobile-battle']
});

function text(html) {
  return String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
function attr(attrs, name) {
  const found = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return found ? found[2] : null;
}
function hasClass(attrs, className) { return (attr(attrs, 'class') || '').split(/\s+/).includes(className); }
function elementEnd(html, start, tag) {
  const token = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'); token.lastIndex = start; let depth = 0; let found;
  while ((found = token.exec(html))) { if (found[0][1] === '/') { depth -= 1; if (depth === 0) return token.lastIndex; } else if (!/\/\s*>$/.test(found[0])) depth += 1; }
  return -1;
}
function tagBlocks(html, tagName = null) {
  const out = []; const tag = /<([a-z][\w:-]*)\b([^>]*)>/gi; let found;
  while ((found = tag.exec(String(html || '')))) {
    if (tagName && found[1].toLowerCase() !== tagName) continue;
    const end = elementEnd(html, found.index, found[1]);
    if (end > 0) out.push({ attrs: found[2], html: html.slice(found.index, end), text: text(html.slice(found.index, end)) });
  }
  return out;
}
function classBlocks(html, className) { return tagBlocks(html).filter((block) => hasClass(block.attrs, className)); }
function firstClassText(html, className) { return classBlocks(html, className)[0]?.text || ''; }
function exactScore(value, scoreA, scoreB) {
  const normalized = String(value).replace(/\s+/g, '');
  return new RegExp(`(?:${scoreA})[：:－–—-](?:${scoreB})(?!\\d)`).test(normalized);
}
function matchMarker(value, no) {
  if (no === null || no === undefined || no === '') return true;
  const escaped = String(no).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:#|場次?|match\\s*)\\s*${escaped}(?!\\d)`, 'i').test(String(value));
}
function expectedNo(expected) {
  if (expected.matchNo !== undefined) return expected.matchNo;
  const suffix = String(expected.matchId || '').match(/-(\d+)$/);
  return suffix ? Number(suffix[1]) : null;
}
function expectedReady(expected) { return Boolean(expected?.teamA && expected?.teamB && Number.isFinite(Number(expected?.scoreA)) && Number.isFinite(Number(expected?.scoreB))); }
function matchTeams(container, expected, teamClass = 'u') {
  const teams = classBlocks(container, teamClass).map((block) => block.text).filter(Boolean);
  return teams.length >= 2 && teams[0] === expected.teamA && teams[1] === expected.teamB;
}
function exactCard(container, expected, { marker = true, dataValue = null } = {}) {
  const rendered = text(container);
  return (!marker || matchMarker(rendered, expectedNo(expected))) && (dataValue === null || String(dataValue) === String(expectedNo(expected)))
    && matchTeams(container, expected) && exactScore(firstClassText(container, 'sc') || rendered, expected.scoreA, expected.scoreB);
}
function qualifyingRows(dom, expected) {
  const groups = [...classBlocks(dom, 'ccard'), ...classBlocks(dom, 'qcell')];
  return groups.some((group) => {
    const gid = attr(group.attrs, 'data-gid');
    if (expected.groupId && gid !== String(expected.groupId)) return false;
    return classBlocks(group.html, 'sc-row').some((row) => {
      const score = firstClassText(row.html, 'sc-score');
      return matchTeams(row.html, expected, 'sc-team') && exactScore(score, expected.scoreA, expected.scoreB);
    });
  });
}
function bracketTeams(seed) {
  return tagBlocks(seed, 'span').filter((span) => !hasClass(span.attrs, 's') && !hasClass(span.attrs, 'chip'))
    .map((span) => span.text).filter(Boolean)[0] || '';
}
function bracketCardMatches(card, expected) {
  if (!matchMarker(firstClassText(card.html, 'gno'), expectedNo(expected))) return false;
  const seeds = classBlocks(card.html, 'seed');
  if (seeds.length < 2) return false;
  return bracketTeams(seeds[0].html) === expected.teamA && bracketTeams(seeds[1].html) === expected.teamB
    && String(firstClassText(seeds[0].html, 's')).trim() === String(expected.scoreA)
    && String(firstClassText(seeds[1].html, 's')).trim() === String(expected.scoreB);
}
function mobileCardMatches(card, expected) {
  if (!matchMarker(firstClassText(card.html, 'live-top'), expectedNo(expected))) return false;
  const lines = classBlocks(card.html, 'score-line');
  if (lines.length !== 2) return false;
  const lineMatches = (line, team, score) => tagBlocks(line.html, 'span').map((span) => span.text).filter(Boolean)[0] === team
    && tagBlocks(line.html, 'strong').map((strong) => strong.text).filter(Boolean)[0] === String(score);
  return lineMatches(lines[0], expected.teamA, expected.scoreA) && lineMatches(lines[1], expected.teamB, expected.scoreB);
}
function stageFor(expected) {
  if (expected?.stage) return expected.stage;
  if (String(expected?.matchId || '').startsWith('qual-')) return 'qualification';
  if (String(expected?.matchId || '').startsWith('knockout-')) return 'knockout';
  if (String(expected?.matchId || '').startsWith('invitational-')) return 'invitational';
  return null;
}
function routeFor(expected) { return (EVENT_ROUTES[stageFor(expected)] || []).map((name) => SITES.find((site) => site.name === name)).filter(Boolean); }

class ChromePool {
  constructor(limit, runner) { this.limit = limit; this.runner = runner; this.running = 0; this.queue = []; }
  async execute(url) {
    return new Promise((resolve, reject) => {
      this.queue.push({ url, resolve, reject }); this.drain();
    });
  }
  drain() {
    while (this.running < this.limit && this.queue.length) {
      const job = this.queue.shift(); this.running += 1;
      Promise.resolve(this.runner(job.url)).then(job.resolve, job.reject).finally(() => { this.running -= 1; this.drain(); });
    }
  }
}

class DualSiteObserver {
  constructor({ chromeRunner = null, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), onEvidence = () => {}, chromeConcurrency = 2 } = {}) {
    const runner = chromeRunner || (async (url) => (await run('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=12000', '--dump-dom', url], { timeout: 20_000, maxBuffer: 2_000_000 })).stdout);
    this.pool = new ChromePool(Math.min(2, Math.max(1, chromeConcurrency)), runner);
    this.sleepFn = sleepFn; this.now = now; this.onEvidence = onEvidence;
    this.pending = new Set(); this.lastSweep = 0; this.findings = []; this.evidence = [];
  }
  emit(evidence) { this.evidence.push(evidence); this.onEvidence(evidence); return evidence; }
  async dom(site) {
    try { return await this.pool.execute(site.url); }
    catch (error) { throw Object.assign(new Error(`OBSERVER_CHROME_P0:${site.name}`), { p0: true, cause: error }); }
  }
  verify(site, dom, expected) {
    if (!expected) return true;
    if (!expectedReady(expected)) return false;
    const no = expectedNo(expected);
    if (site.kind === 'live') return classBlocks(dom, 'cell').some((card) => exactCard(card.html, expected, { marker: false, dataValue: attr(card.attrs, 'data-n') || no }));
    if (site.kind === 'qualifying') return qualifyingRows(dom, expected);
    if (site.kind === 'bracket') return classBlocks(dom, 'r1card').some((card) => bracketCardMatches(card, expected));
    if (site.kind === 'mobile') return classBlocks(dom, 'live-card').some((card) => mobileCardMatches(card, expected));
    return false;
  }
  async sample(site, expected = null, label = 'sweep', startedAt = this.now()) {
    const dom = await this.dom(site);
    const missingExpectedTeams = Boolean(expected && !expectedReady(expected));
    const seen = !expected ? true : this.verify(site, dom, expected);
    const parsedUrl = new URL(site.url);
    return this.emit({ site: site.name, url: `${parsedUrl.pathname}${parsedUrl.search}`, rendered: true, seen, sample: label, eventId: expected?.matchId || null, stage: stageFor(expected), bytes: dom.length, at: new Date().toISOString(), latencyMs: this.now() - startedAt, missingExpectedTeams });
  }
  async sweep() {
    this.lastSweep = this.now();
    return Promise.all(SITES.map((site) => this.sample(site, null, 'sweep', this.lastSweep)));
  }
  observeEvent(expected) {
    const task = (async () => {
      if (!expected || typeof expected === 'string') return { eventId: typeof expected === 'string' ? expected : null, seen: false, latencyMs: 0, timeout: false, skipped: true };
      if (!expectedReady(expected)) {
        this.findings.push({ code: 'OBSERVER_EXPECTED_TEAMS_MISSING', severity: 'non_p0', eventId: expected.matchId || null, at: new Date().toISOString() });
        return { eventId: expected.matchId || null, seen: false, latencyMs: 0, timeout: false, skipped: true };
      }
      const routes = routeFor(expected);
      if (!routes.length) { this.findings.push({ code: 'OBSERVER_STAGE_ROUTE_MISSING', severity: 'non_p0', eventId: expected.matchId, at: new Date().toISOString() }); return { eventId: expected.matchId, seen: false, latencyMs: 0, timeout: false, skipped: true }; }
      const startedAt = this.now(); const deadline = startedAt + 120_000; let completed = false;
      while (this.now() <= deadline && !completed) {
        const results = await Promise.all(routes.map((site) => this.sample(site, expected, 'event', startedAt)));
        completed = results.every((result) => result.seen);
        if (!completed && this.now() + 30_000 <= deadline) await this.sleepFn(30_000); else break;
      }
      const eventEvidence = this.evidence.filter((item) => item.eventId === expected.matchId && item.sample === 'event');
      if (completed) {
        const latencyMs = Math.max(...eventEvidence.filter((item) => item.seen).map((item) => item.latencyMs), 0);
        this.findings.push({ code: 'OBSERVER_EVENT_VISIBLE', severity: 'info', eventId: expected.matchId, at: new Date().toISOString(), latencyMs, sites: routes.map((site) => site.name) });
        return { eventId: expected.matchId, seen: true, latencyMs, timeout: false, sites: routes.map((site) => site.name) };
      }
      const latencyMs = this.now() - startedAt;
      this.findings.push({ code: 'DISPLAY_SYNC_TIMEOUT', severity: 'non_p0', eventId: expected.matchId, at: new Date().toISOString(), latencyMs, sites: routes.map((site) => site.name) });
      return { eventId: expected.matchId, seen: false, latencyMs, timeout: true, sites: routes.map((site) => site.name) };
    })();
    const cleanup = () => this.pending.delete(task);
    this.pending.add(task); task.then(cleanup, cleanup); return task;
  }
  async afterWrite(match) {
    if (this.now() - this.lastSweep >= 90_000) await this.sweep();
    return this.observeEvent(typeof match === 'string' ? { matchId: match } : match);
  }
  async pendingEvidence(matchId) {
    const expected = typeof matchId === 'object' ? matchId : { matchId };
    const primary = stageFor(expected) === 'knockout' ? 'main-bracket' : 'main-qualifying';
    const sites = [SITES.find((site) => site.name === primary), SITES.find((site) => site.name === 'mobile-advance')].filter(Boolean);
    const startedAt = this.now(); const deadline = startedAt + 120_000; let pendingObserved = false; let latest = [];
    while (this.now() <= deadline && !pendingObserved) {
      const results = await Promise.all(sites.map(async (site) => {
        const dom = await this.dom(site); const seen = text(dom).includes('並列待判定');
        const parsedUrl = new URL(site.url);
        return this.emit({ site: site.name, url: `${parsedUrl.pathname}${parsedUrl.search}`, rendered: true, seen, sample: 'pending-decision', eventId: expected.matchId || null, at: new Date().toISOString(), latencyMs: this.now() - startedAt });
      }));
      latest = results;
      // C2 的前提是兩個對外窗口都已呈現待裁定，不接受只在其中一頁出現。
      pendingObserved = results.length === 2 && results.every((result) => result.seen);
      if (!pendingObserved && this.now() + 30_000 <= deadline) await this.sleepFn(30_000); else break;
    }
    const siteEvidence = latest.map((result) => ({ site: result.site, seen: result.seen, latencyMs: result.latencyMs }));
    if (!pendingObserved) this.findings.push({ code: 'PENDING_TIE_NOT_VISIBLE', severity: 'non_p0', eventId: expected.matchId || null, at: new Date().toISOString(), sites: siteEvidence });
    return { matchId: expected.matchId || null, pendingObserved, sites: siteEvidence, at: new Date().toISOString(), latencyMs: this.now() - startedAt };
  }
  async flush() { await Promise.all([...this.pending]); return this.findings.slice(); }
}

module.exports = { DualSiteObserver, SITES, EVENT_ROUTES, classBlocks, tagBlocks, text, routeFor, mobileCardMatches };
