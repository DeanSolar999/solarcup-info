'use strict';

/*
 * A–K 場景編譯器。權威場次、slot、場地來自 schedule-data.js；
 * 資格賽／曜請隊名來自 fullPlan() 中由 tournament-data.js 建立的對照。
 * 編譯器只描述先後關係，真正等待、凍結、serial write 由 runner 執行。
 */
const { scoreFor, assertLegalScore, fullPlan } = require('./lib');
const schedule = require('../schedule-data.js');
const { loadTopology, deriveAll, seedsFor, rankGroup, TIER_KEYS, TIER_META } = require('./bracket');

const B_NOS = Object.freeze([1, 6, 21, 26, 41, 46]);
const B_SCORES = Object.freeze([[21, 10], [21, 10], [19, 21], [21, 20], [21, 0], [21, 20]]);
const C3_NOS = Object.freeze([2, 7, 22, 27, 42, 47]);
const C3_SCORES = Object.freeze([[21, 11], [21, 0], [11, 21], [21, 0], [21, 0], [21, 11]]);
const C5_NOS = Object.freeze([191, 192, 211, 212, 239, 240, 259, 260, 277, 278]);
const C5_SCORES = Object.freeze([[21, 11], [21, 11], [11, 21], [11, 21], [21, 11], [21, 11], [11, 21], [21, 11], [21, 11], [21, 11]]);
const FIXED_SCORES = new Map([
  ...B_NOS.map((no, index) => [no, B_SCORES[index]]),
  ...C3_NOS.map((no, index) => [no, C3_SCORES[index]]),
  ...C5_NOS.map((no, index) => [no, C5_SCORES[index]])
]);

const SCENARIOS = Object.freeze({
  A: '快慢節奏', B: '同勝場', C: '三／五角並列待裁定', D: '棄賽 0:21',
  E: '延遲補登', F: '受控未完成 0:0', G: '填反後更正', H: '開幕空檔',
  I: '同 slot serial queue', J: '四強凍結／解凍', K: '球團同分並列'
});

function assertCompletedScore(score) {
  assertLegalScore(score);
  if (score[0] === score[1]) throw Object.assign(new Error(`COMPLETED_TIE:${score[0]}:${score[1]}`), { p0: true });
  return score;
}

function minutes(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text || '');
  if (!match) throw new Error(`SCHEDULE_TIME_INVALID:${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function scoreForScenario(runId, match, scenario) {
  if (scenario === 'D') return [0, 21];
  return assertCompletedScore(scoreFor(runId, match.id));
}

function finalFourGates() {
  const topology = loadTopology().MNO;
  const result = new Map();
  for (const [tier, tierPlan] of Object.entries(topology)) {
    const semiPrerequisites = tierPlan.qf || [...tierPlan.rrA, ...tierPlan.rrB];
    tierPlan.sf.forEach((no) => result.set(no, { tier, phase: 'semifinal', prerequisiteNos: semiPrerequisites }));
    [tierPlan.final, tierPlan.third].forEach((no) => result.set(no, { tier, phase: 'medal', prerequisiteNos: tierPlan.sf }));
  }
  return result;
}

function fixtureStats(teams, matches) {
  const stats = Object.fromEntries(teams.map((name) => [name, { name, wins: 0, gf: 0, ga: 0, ratio: 0 }]));
  for (const match of matches) {
    const a = stats[match.a]; const b = stats[match.b];
    a.gf += match.sa; a.ga += match.sb; b.gf += match.sb; b.ga += match.sa;
    if (match.sa > match.sb) a.wins += 1; else b.wins += 1;
  }
  Object.values(stats).forEach((item) => { item.ratio = item.ga ? item.gf / item.ga : 999; });
  return stats;
}

function simulateClubProjection(plan, flippedNos = new Set()) {
  const topology = loadTopology();
  const source = require('../tournament-data.js').SolarCupData;
  const roster = source.buildAllTeams(null).teams.filter((team) => team.track !== '曜請');
  const metaByName = new Map(roster.map((team, index) => [team.label, { no: index + 1, club: team.clubFull, track: team.track }]));
  const scoreOf = (match) => flippedNos.has(match.no) ? [match.score[1], match.score[0]] : match.score;
  const groups = new Map();
  plan.filter((match) => match.stage === 'qualification').forEach((match) => {
    const list = groups.get(match.schedule.code) || [];
    list.push(match); groups.set(match.schedule.code, list);
  });
  const qualification = [];
  for (const [code, groupMatches] of groups) {
    const teams = [...new Set(groupMatches.flatMap((match) => [match.teamA, match.teamB]))];
    const matches = groupMatches.map((match) => {
      const score = scoreOf(match);
      return { a: match.teamA, b: match.teamB, sa: score[0], sb: score[1], done: true };
    });
    const ranked = rankGroup(teams, matches).ranked;
    const competitive = code.startsWith('競');
    ranked.forEach((name, index) => qualification.push({
      no: metaByName.get(name).no, name, rank: index + 1,
      tier: index < 2 ? (competitive ? '白金' : '白銀') : (competitive ? '黃金' : '青銅')
    }));
  }
  if (qualification.length !== 100) throw new Error(`K_ORACLE_QUALIFICATION_SIZE:${qualification.length}/100`);
  const seeds = {};
  for (const tier of TIER_KEYS) seeds[tier] = seedsFor(tier, qualification);
  const results = {}; const knockout = plan.filter((match) => match.stage === 'knockout');
  let progress = true;
  while (progress) {
    progress = false;
    const { pairs } = deriveAll(topology, seeds, results);
    for (const match of knockout) {
      if (results[match.no]) continue;
      const pair = pairs[match.no];
      if (!pair) continue;
      const score = scoreOf(match);
      results[match.no] = { a: pair[0], b: pair[1], sa: score[0], sb: score[1], winner: score[0] > score[1] ? pair[0] : pair[1] };
      progress = true;
    }
  }
  if (Object.keys(results).length !== 132) throw new Error(`K_ORACLE_KNOCKOUT_SIZE:${Object.keys(results).length}/132`);

  const stop = new Map();
  const setStop = (name, value) => { if (name) stop.set(name, value); };
  const loser = (no) => results[no].winner === results[no].a ? results[no].b : results[no].a;
  for (const tier of TIER_KEYS) {
    const matches = topology.MNO[tier]; const meta = TIER_META[tier];
    matches.pre.forEach((no) => setStop(loser(no), '初賽止步'));
    if (meta.type === 'comp') {
      [matches.rrA, matches.rrB].forEach((nos) => {
        const teams = [...new Set(nos.flatMap((no) => [results[no].a, results[no].b]))];
        rankGroup(teams, nos.map((no) => ({ ...results[no], done: true }))).ranked.forEach((name, index) => {
          if (index >= 2) setStop(name, '複賽止步');
        });
      });
    } else {
      const teams = [...new Set(matches.tri.flatMap((no) => [results[no].a, results[no].b]))];
      rankGroup(teams, matches.tri.map((no) => ({ ...results[no], done: true }))).ranked.forEach((name, index) => {
        if (index >= 2) setStop(name, '複賽止步');
      });
      matches.ko.forEach((no) => setStop(loser(no), '複賽止步'));
      matches.qf.forEach((no) => setStop(loser(no), '8強止步'));
    }
    setStop(results[matches.final].winner, '冠軍'); setStop(loser(matches.final), '亞軍');
    setStop(results[matches.third].winner, '季軍'); setStop(loser(matches.third), '殿軍');
  }
  const base = { '白金': 300, '黃金': 200, '白銀': 100, '青銅': 0 };
  const place = {
    '競技': { '冠軍': 100, '亞軍': 80, '季軍': 60, '殿軍': 60, '複賽止步': 40, '初賽止步': 0 },
    '休閒': { '冠軍': 100, '亞軍': 80, '季軍': 60, '殿軍': 60, '8強止步': 40, '複賽止步': 20, '初賽止步': 0 }
  };
  const clubs = {}; const teamScores = [];
  for (const row of qualification) {
    const meta = metaByName.get(row.name); const total = base[row.tier] + (place[meta.track][stop.get(row.name)] || 0);
    const club = clubs[meta.club] ||= { total: 0, comp: 0 };
    club.total += total; if (meta.track === '競技') club.comp += total;
    teamScores.push({ name: row.name, club: meta.club, type: `${meta.track}組`, total });
  }
  return { clubs, teamScores };
}

function clubTieCondition(clubs, { requireDisjoint = true } = {}) {
  const entries = Object.entries(clubs).filter(([name]) => name !== '自由組');
  const different = []; const joint = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [a, A] = entries[left]; const [b, B] = entries[right];
      if (A.total !== B.total) continue;
      if (A.comp !== B.comp) different.push({ clubs: [a, b], total: A.total, comps: [A.comp, B.comp] });
      else joint.push({ clubs: [a, b], total: A.total, comp: A.comp });
    }
  }
  for (const differentPair of different) {
    const jointPair = joint.find((candidate) => !requireDisjoint || candidate.clubs.every((club) => !differentPair.clubs.includes(club)));
    if (jointPair) return { different: differentPair, joint: jointPair };
  }
  return null;
}

function findClubTieFixture(plan, { maxFlips = 2, requireDisjoint = true } = {}) {
  const topology = loadTopology().MNO;
  // Bounded to the 24 medal-path matches. Increasing-cardinality traversal
  // proves minimality inside this explicitly recorded candidate surface.
  const candidates = [...new Set(TIER_KEYS.flatMap((tier) => {
    const matches = topology[tier];
    return [...(matches.qf || []), ...matches.sf, matches.final, matches.third];
  }))].sort((a, b) => a - b);
  for (let size = 0; size <= maxFlips; size += 1) {
    let found = null;
    const visit = (start, selected) => {
      if (found) return;
      if (selected.length === size) {
        const projection = simulateClubProjection(plan, new Set(selected));
        const expected = clubTieCondition(projection.clubs, { requireDisjoint });
        if (expected) found = { flipNos: [...selected], expected, projection, candidateCount: candidates.length, minimalFlips: size };
        return;
      }
      for (let index = start; index < candidates.length && !found; index += 1) visit(index + 1, [...selected, candidates[index]]);
    };
    visit(0, []);
    if (found) return found;
  }
  throw Object.assign(new Error(`K_FIXTURE_NOT_FOUND:maxFlips=${maxFlips}:candidates=${candidates.length}`), { p0: true });
}

function applyClubTieFixture(plan, options) {
  const fixture = findClubTieFixture(plan, options);
  fixture.flipNos.forEach((no) => {
    const match = plan.find((candidate) => candidate.no === no);
    if (!match) throw new Error(`K_FIXTURE_MATCH_MISSING:${no}`);
    match.score = [match.score[1], match.score[0]];
    const completed = match.steps.find((step) => step.type === 'WRITE_COMPLETED');
    if (completed) completed.score = match.score;
  });
  const trigger = plan.find((match) => match.no === 310);
  if (!trigger) throw new Error('K_FIXTURE_TRIGGER_MISSING');
  trigger.kFixture = { flipNos: fixture.flipNos, expected: fixture.expected, minimalFlips: fixture.minimalFlips, candidateCount: fixture.candidateCount };
  return fixture;
}

function buildScenarioPlan(runId, basePlan = fullPlan()) {
  if (!Array.isArray(basePlan) || basePlan.length !== 310) throw new Error('SCENARIO_PLAN_SIZE_INVALID');
  if (!schedule?.matches || schedule.matches.length !== 310) throw new Error('SCHEDULE_310_REQUIRED');
  const scheduleByNo = new Map(schedule.matches.map((match) => [match.n, match]));
  const baseByNo = new Map(basePlan.map((match) => [match.no, match]));
  if (baseByNo.size !== 310 || scheduleByNo.size !== 310) throw new Error('SCHEDULE_MATCH_NUMBER_COVERAGE_INVALID');

  const openingEvents = schedule.events.filter((event) => event.label.includes('開幕'));
  const openingStart = Math.min(...openingEvents.map((event) => minutes(event.s)));
  const openingEnd = Math.max(...openingEvents.map((event) => minutes(event.e)));
  const openingGap = {
    start: openingEvents.find((event) => minutes(event.s) === openingStart).s,
    end: openingEvents.find((event) => minutes(event.e) === openingEnd).e,
    durationSeconds: (openingEnd - openingStart) * 60,
    assertion: 'authoritative_opening_gap_no_writes'
  };

  const slots = new Map();
  for (const item of schedule.matches) {
    const list = slots.get(item.s) || [];
    list.push(item);
    slots.set(item.s, list);
  }
  const aSlot = slots.get('08:40');
  const aMembers = aSlot.filter((item) => item.ct === 3 || item.ct === 7).map((item) => item.n);
  if (aMembers.length !== 2) throw new Error('SCENARIO_A_PAIR_MISSING');
  const iSlot = [...slots.entries()].find(([time, list]) => time >= '12:50' && list.length === 10);
  if (!iSlot) throw new Error('SCENARIO_I_SLOT_MISSING');
  const iMembers = iSlot[1].map((item) => item.n);
  const gates = finalFourGates();

  const singleScenario = new Map([[40, 'D'], [55, 'E'], [70, 'F'], [88, 'G'], [111, 'H'], [310, 'K']]);
  const planned = schedule.matches.map((scheduled) => {
    const match = baseByNo.get(scheduled.n);
    if (!match) throw new Error(`PLAN_MATCH_NUMBER_MISSING:${scheduled.n}`);
    let scenario = singleScenario.get(scheduled.n) || 'NORMAL';
    if (B_NOS.includes(scheduled.n)) scenario = 'B';
    if (C3_NOS.includes(scheduled.n) || C5_NOS.includes(scheduled.n)) scenario = 'C';
    if (aMembers.includes(scheduled.n)) scenario = 'A';
    if (iMembers.includes(scheduled.n)) scenario = 'I';
    if (scheduled.n === 299) scenario = 'J';
    const score = assertCompletedScore(FIXED_SCORES.get(scheduled.n) || scoreForScenario(runId, match, scenario));
    const steps = [{ type: 'WRITE_COMPLETED', score }];
    if (scheduled.n === 46) steps.unshift({ type: 'STANDINGS_ASSERT', assertion: 'same_wins_ratio_rank' });
    if (scheduled.n === 47) steps.unshift({ type: 'STANDINGS_ASSERT', assertion: 'c3_equal_pending_visible_no_h2h' });
    if (scheduled.n === 278) steps.unshift({ type: 'STANDINGS_ASSERT', assertion: 'c5_equal_pending_no_h2h' });
    if (scenario === 'D') steps.unshift({ type: 'FORFEIT_ASSERT', assertion: 'forfeit_0_21' });
    if (scenario === 'E') steps.unshift({ type: 'DELAY', seconds: 35, assertion: 'late_entry_before_write' });
    if (scenario === 'F') steps.unshift({ type: 'WRITE_INCOMPLETE', score: [0, 0], maxSeconds: 120, assertion: 'incomplete_corrected_within_120s' });
    if (scenario === 'G') steps.unshift({ type: 'WRITE_REVERSED', score: [...score].reverse(), assertion: 'reversed_score_corrected' });
    if (scenario === 'H') steps.unshift({ type: 'SCHEDULE_GAP', ...openingGap });
    if (scenario === 'I') steps.unshift({ type: 'SERIAL_SLOT_WINDOW', groupId: `slot-${iSlot[0]}`, memberNos: iMembers, courts: 10, windowSeconds: 60, assertion: 'ten_courts_serial_within_60s' });
    if (scenario === 'J') steps.unshift({ type: 'TIER_FREEZE', assertion: 'prerequisite_freeze_then_unfreeze' });
    if (scenario === 'K') steps.unshift({ type: 'CLUB_ASSERT', assertion: 'club_total_comp_rank_and_joint_rank' });

    const gate = gates.get(scheduled.n);
    return {
      ...match,
      scenario,
      score,
      schedule: scheduled,
      dueAt: scheduled.s,
      teamA: match.teamA || null,
      teamB: match.teamB || null,
      venuePace: aMembers.includes(scheduled.n) ? {
        groupId: `pace-${scheduled.s}`,
        role: scheduled.ct === 3 ? 'early' : 'late',
        counterpartNo: aMembers.find((no) => no !== scheduled.n),
        assertion: 'court3_before_court7_same_slot'
      } : null,
      openingGap: scenario === 'H' ? openingGap : null,
      serialWindow: scenario === 'I' ? { groupId: `slot-${iSlot[0]}`, memberNos: iMembers, windowSeconds: 60, serial: true } : null,
      finalFourGate: gate ? { ...gate, prerequisiteIds: gate.prerequisiteNos.map((no) => baseByNo.get(no)?.id).filter(Boolean), forceFreezeProbe: scheduled.n === 299 } : null,
      incomplete: scenario === 'F' ? { score: [0, 0], maxSeconds: 120 } : null,
      correction: scenario === 'G',
      fixture: B_NOS.includes(scheduled.n) ? { id: 'B-競資-A', memberNos: B_NOS, trigger: scheduled.n === 46 }
        : C3_NOS.includes(scheduled.n) ? { id: 'C3-競資-B', memberNos: C3_NOS, trigger: scheduled.n === 47, pendingDom: true }
          : C5_NOS.includes(scheduled.n) ? { id: 'C5-plat-rrA', memberNos: C5_NOS, trigger: scheduled.n === 278, pendingDecision: true }
            : null,
      c2: scheduled.n === 47 || scheduled.n === 278,
      expected: { completed: true, noH2H: true, tiePolicy: 'wins_then_ratio_then_pending_decision' },
      steps
    };
  });

  // J 需要真的 freeze 證據：將青銅冠亞賽 #299 放到第二場準決賽 #288 前先嘗試。
  // runner 必須先擋下，等 #288 完成後才能解凍寫入。
  planned.sort((a, b) => {
    const order = (match) => match.no === 299 ? 287.5 : match.no;
    return order(a) - order(b);
  });
  return planned;
}

function scenarioFor(index) {
  return buildScenarioPlan('scenario-index').at(index)?.scenario || 'NORMAL';
}

module.exports = {
  SCENARIOS, B_NOS, B_SCORES, C3_NOS, C3_SCORES, C5_NOS, C5_SCORES,
  assertCompletedScore, scenarioFor, scoreForScenario, buildScenarioPlan, minutes,
  fixtureStats, simulateClubProjection, clubTieCondition, findClubTieFixture, applyClubTieFixture
};
