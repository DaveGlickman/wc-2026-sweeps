/*
 * World Cup 2026 Sweeps — front-end.
 *
 * Reads the committed JSON (same origin, no API key here) and computes the
 * leaderboard in the browser. All point values come from scoring.json, so the
 * rules can be tuned by editing one file with no code changes.
 */

'use strict';

const CONFIG = './config';
const DATA = './data';

const FINISHED = new Set(['FT', 'AET', 'PEN', 'WO']);
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE']);

// Ordered stages for the "furthest team" tiebreaker and progression awards.
const STAGE_ORDER = ['Group', 'R32', 'R16', 'QF', 'SF', 'Final', 'Champions'];
const STAGE_LABEL = {
  Group: 'Group stage',
  R32: 'Round of 32',
  R16: 'Round of 16',
  QF: 'Quarter-final',
  SF: 'Semi-final',
  Final: 'Final',
  Champions: 'Champions'
};

function $(sel) { return document.querySelector(sel); }

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

function roundKey(round) {
  const r = (round || '').toLowerCase();
  if (r.includes('round of 32') || r.includes('1/16')) return 'R32';
  if (r.includes('round of 16') || r.includes('1/8')) return 'R16';
  if (r.includes('quarter')) return 'QF';
  if (r.includes('3rd place') || r.includes('third place')) return null;
  if (r.includes('semi')) return 'SF';
  if (r.includes('final')) return 'Final';
  return null; // group stage / other
}

function isDefensive(pos) {
  return pos === 'D' || pos === 'G' || pos === 'Defender' || pos === 'Goalkeeper';
}

// ---- Build lookups from fixtures -----------------------------------------

function buildIndex(matches) {
  const fixtures = (matches && matches.fixtures) || [];
  const teamName = new Map();
  for (const f of fixtures) {
    if (f.homeTeam) teamName.set(f.homeTeam.id, f.homeTeam.name);
    if (f.awayTeam) teamName.set(f.awayTeam.id, f.awayTeam.name);
  }
  return { fixtures, teamName };
}

// ---- Team scoring ---------------------------------------------------------

function scoreTeam(teamId, idx, scoring) {
  const s = scoring.team;
  const prog = scoring.teamProgression;
  let played = 0, w = 0, d = 0, l = 0, cs = 0;
  let matchPoints = 0;
  const reached = new Set(['Group']);
  let champion = false;

  for (const f of idx.fixtures) {
    const isHome = f.homeTeam && f.homeTeam.id === teamId;
    const isAway = f.awayTeam && f.awayTeam.id === teamId;
    if (!isHome && !isAway) continue;

    const rk = roundKey(f.round);
    if (rk) reached.add(rk);

    if (!f.finished) continue;
    const gf = isHome ? f.homeTeam.goals : f.awayTeam.goals;
    const ga = isHome ? f.awayTeam.goals : f.homeTeam.goals;
    if (gf == null || ga == null) continue;

    played++;
    if (gf > ga) { w++; matchPoints += s.win; }
    else if (gf === ga) { d++; matchPoints += s.draw; }
    else { l++; matchPoints += s.loss; }
    if (ga === 0) { cs++; matchPoints += s.cleanSheet; }

    if (rk === 'Final' && f.winnerTeamId === teamId) champion = true;
  }

  if (champion) reached.add('Champions');

  let progPoints = 0;
  for (const k of ['R16', 'QF', 'SF', 'Final', 'Champions']) {
    if (reached.has(k) && prog[k]) progPoints += prog[k];
  }

  let furthest = 'Group';
  for (const k of STAGE_ORDER) if (reached.has(k)) furthest = k;

  return {
    id: teamId,
    name: idx.teamName.get(teamId) || null,
    played, w, d, l, cs,
    points: matchPoints + progPoints,
    matchPoints,
    progPoints,
    furthest,
    champion,
    stageRank: STAGE_ORDER.indexOf(furthest)
  };
}

// ---- Player scoring -------------------------------------------------------

function scorePlayer(playerId, scoring, idx, motm) {
  const s = scoring.player;
  let goals = 0, assists = 0, yellow = 0, red = 0, ownGoals = 0, cleanSheets = 0, motmCount = 0;
  let liveName = null;

  for (const f of idx.fixtures) {
    const entry = (f.players || []).find((p) => p.id === playerId);
    if (entry) {
      liveName = liveName || entry.name;
      goals += entry.goals || 0;
      assists += entry.assists || 0;
      yellow += entry.yellow || 0;
      red += entry.red || 0;
      ownGoals += entry.ownGoals || 0;

      if (f.finished && isDefensive(entry.position) && (entry.minutes || 0) > 0) {
        const conceded = (f.homeTeam.id === entry.teamId)
          ? f.awayTeam.goals
          : f.homeTeam.goals;
        if (conceded === 0) cleanSheets++;
      }
    }
    if (f.finished && motm[String(f.id)] === playerId) motmCount++;
  }

  const points =
    goals * s.goal +
    assists * s.assist +
    motmCount * s.motm +
    cleanSheets * s.cleanSheet +
    yellow * s.yellow +
    red * s.red +
    ownGoals * s.ownGoal;

  return { id: playerId, name: liveName, goals, assists, yellow, red, ownGoals, cleanSheets, motmCount, points };
}

// ---- Assemble people ------------------------------------------------------

function mergePeople(allocations, picks) {
  const map = new Map();
  for (const p of (allocations.people || [])) {
    map.set(p.name, { name: p.name, teams: p.teams || [], players: [] });
  }
  for (const p of (picks.people || [])) {
    if (!map.has(p.name)) map.set(p.name, { name: p.name, teams: [], players: [] });
    map.get(p.name).players = p.players || [];
  }
  return Array.from(map.values());
}

// Paid-only gate. Returns a Set of paid entrant names to filter by, or null
// when entrants.json is absent (then no gating, for backwards compatibility).
// If the file exists but nobody is paid, returns an empty Set (empty board).
function buildPaidSet(entrants) {
  if (!entrants || !Array.isArray(entrants.people)) return null;
  return new Set(
    entrants.people.filter((p) => p && p.paid === true).map((p) => p.name)
  );
}

function computeStandings(data) {
  const { scoring, allocations, picks, motm, idx, paidSet } = data;
  const motmMap = (motm && motm.motm) || {};
  let people = mergePeople(allocations, picks);
  if (paidSet) people = people.filter((p) => paidSet.has(p.name));

  const standings = people.map((person) => {
    const teams = (person.teams || []).map((t) => {
      const r = scoreTeam(t.id, idx, scoring);
      r.hint = t.name;
      return r;
    });
    const players = (person.players || []).map((p) => {
      const r = scorePlayer(p.id, scoring, idx, motmMap);
      r.hint = p.name;
      return r;
    });

    const teamPts = teams.reduce((a, t) => a + t.points, 0);
    const playerPts = players.reduce((a, p) => a + p.points, 0);
    const playerGoals = players.reduce((a, p) => a + p.goals, 0);
    const furthestRank = teams.reduce((a, t) => Math.max(a, t.stageRank), 0);

    return {
      name: person.name,
      teams,
      players,
      teamPts,
      playerPts,
      total: teamPts + playerPts,
      playerGoals,
      furthestRank
    };
  });

  // Tiebreakers: total -> combined player goals -> furthest team -> name (stable stand-in for coin flip).
  standings.sort((a, b) =>
    b.total - a.total ||
    b.playerGoals - a.playerGoals ||
    b.furthestRank - a.furthestRank ||
    a.name.localeCompare(b.name)
  );

  // Dense-ish ranking with shared rank on exact ties (same total + goals + furthest).
  let rank = 0, prevKey = null;
  standings.forEach((row, i) => {
    const key = `${row.total}|${row.playerGoals}|${row.furthestRank}`;
    if (key !== prevKey) { rank = i + 1; prevKey = key; }
    row.rank = rank;
  });

  return standings;
}

// ---- Rendering ------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function teamStatusTag(team, idx) {
  // Is any of this team's fixtures live right now?
  for (const f of idx.fixtures) {
    const involved = (f.homeTeam && f.homeTeam.id === team.id) || (f.awayTeam && f.awayTeam.id === team.id);
    if (involved && LIVE.has(f.status)) return { cls: 'live', label: 'LIVE' };
  }
  if (team.champion) return { cls: 'fin', label: 'CHAMPIONS' };
  return { cls: 'fin', label: STAGE_LABEL[team.furthest] };
}

function renderTeam(team, idx) {
  const row = el('div', 'entity');
  const left = el('div');
  const nm = el('div', 'e-name', team.name || team.hint || `Team #${team.id}`);
  const tag = teamStatusTag(team, idx);
  const tagEl = el('span', `tag ${tag.cls}`, tag.label);
  nm.appendChild(tagEl);
  left.appendChild(nm);
  left.appendChild(el('div', 'e-sub',
    `${team.played} pld · ${team.w}W ${team.d}D ${team.l}L · ${team.cs} CS · prog ${team.progPoints}`));
  row.appendChild(left);
  const pts = el('div', `e-pts ${team.points >= 0 ? 'pos' : 'neg'}`, fmt(team.points));
  row.appendChild(pts);
  return row;
}

function renderPlayer(player) {
  const row = el('div', 'entity');
  const left = el('div');
  left.appendChild(el('div', 'e-name', player.name || player.hint || `Player #${player.id}`));
  const bits = [];
  if (player.goals) bits.push(`${player.goals}G`);
  if (player.assists) bits.push(`${player.assists}A`);
  if (player.cleanSheets) bits.push(`${player.cleanSheets}CS`);
  if (player.motmCount) bits.push(`${player.motmCount}MOTM`);
  if (player.yellow) bits.push(`${player.yellow}Y`);
  if (player.red) bits.push(`${player.red}R`);
  if (player.ownGoals) bits.push(`${player.ownGoals}OG`);
  left.appendChild(el('div', 'e-sub', bits.length ? bits.join(' · ') : 'no points yet'));
  row.appendChild(left);
  row.appendChild(el('div', `e-pts ${player.points >= 0 ? 'pos' : 'neg'}`, fmt(player.points)));
  return row;
}

function fmt(n) { return (n > 0 ? '+' : '') + n; }

function renderLeaderboard(standings, idx) {
  const list = $('#leaderboard');
  list.innerHTML = '';

  standings.forEach((row) => {
    const li = el('li', `row rank-${row.rank}`);

    const head = el('div', 'row-head');
    head.appendChild(el('div', 'rank', row.rank));

    const person = el('div', 'person');
    person.appendChild(el('div', 'name', row.name));
    person.appendChild(el('div', 'breakdown',
      `team ${row.teamPts} · player ${row.playerPts}`));
    head.appendChild(person);

    const total = el('div', 'total');
    total.appendChild(el('span', 'pts', row.total));
    total.appendChild(el('span', 'lbl', 'pts'));
    total.appendChild(el('span', 'chev', '›'));
    head.appendChild(total);

    const detail = el('div', 'detail');
    detail.appendChild(el('h3', null, 'Teams'));
    if (row.teams.length) row.teams.forEach((t) => detail.appendChild(renderTeam(t, idx)));
    else detail.appendChild(el('div', 'e-sub', 'No teams allocated.'));
    detail.appendChild(el('h3', null, 'Players'));
    if (row.players.length) row.players.forEach((p) => detail.appendChild(renderPlayer(p)));
    else detail.appendChild(el('div', 'e-sub', 'No players picked.'));

    head.addEventListener('click', () => li.classList.toggle('open'));

    li.appendChild(head);
    li.appendChild(detail);
    list.appendChild(li);
  });

  $('#leaderboard-section').hidden = false;
}

function renderRules(scoring, entrantCount) {
  const wrap = $('#rules');
  wrap.innerHTML = '';

  if (entrantCount != null) {
    const head = el('p', 'entrants-note');
    head.innerHTML =
      `<strong>${entrantCount}</strong> paid ${entrantCount === 1 ? 'entrant' : 'entrants'} in the pot.`;
    wrap.appendChild(head);
  }

  const section = (title, pairs) => {
    wrap.appendChild(el('h4', null, title));
    const grid = el('div', 'rules-grid');
    pairs.forEach(([k, v]) => {
      grid.appendChild(el('div', 'k', k));
      grid.appendChild(el('div', 'v', v > 0 ? `+${v}` : `${v}`));
    });
    wrap.appendChild(grid);
  };

  const t = scoring.team;
  section('Team — per match', [
    ['Win', t.win], ['Draw', t.draw], ['Loss', t.loss], ['Clean sheet', t.cleanSheet]
  ]);

  const pr = scoring.teamProgression;
  section('Team — progression (once each)', [
    ['Reach Round of 16', pr.R16], ['Reach Quarter-final', pr.QF],
    ['Reach Semi-final', pr.SF], ['Reach Final', pr.Final], ['Champions', pr.Champions]
  ]);

  const p = scoring.player;
  section('Player — per match', [
    ['Goal', p.goal], ['Assist', p.assist], ['Man of the Match', p.motm],
    ['Clean sheet (DEF/GK)', p.cleanSheet], ['Yellow card', p.yellow],
    ['Red card', p.red], ['Own goal', p.ownGoal]
  ]);

  const pay = scoring.payout;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const note = el('p', 'payout-note');
  note.innerHTML =
    `<strong>Payout:</strong> pot split ${pct(pay.first)} / ${pct(pay.second)} / ${pct(pay.third)} ` +
    `to 1st / 2nd / 3rd. Each person's total = both teams + both players.`;
  wrap.appendChild(note);
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
}

// ---- Boot -----------------------------------------------------------------

async function main() {
  const status = $('#status');
  try {
    const [scoring, allocations, picks, motm, matches, entrants] = await Promise.all([
      getJSON(`${CONFIG}/scoring.json`),
      getJSON(`${CONFIG}/allocations.json`),
      getJSON(`${CONFIG}/picks.json`),
      getJSON(`${CONFIG}/motm.json`),
      getJSON(`${DATA}/matches.json`),
      getJSON(`${CONFIG}/entrants.json`).catch(() => null)
    ]);

    const idx = buildIndex(matches);
    const paidSet = buildPaidSet(entrants);

    const standings = computeStandings({ scoring, allocations, picks, motm, idx, paidSet });
    const entrantCount = paidSet ? paidSet.size : standings.length;
    renderRules(scoring, entrantCount);

    if (!standings.length) {
      status.textContent = paidSet
        ? 'No paid entrants yet. Mark people "paid": true in config/entrants.json and run the draw.'
        : 'No people configured yet. Add entries to config/allocations.json and config/picks.json.';
    } else {
      status.hidden = true;
      renderLeaderboard(standings, idx);
    }

    let stamp = matches.generatedAt;
    try { stamp = (await getText(`${DATA}/last-updated.txt`)).trim() || stamp; } catch { /* keep generatedAt */ }
    $('#last-updated').textContent = stamp ? `Updated ${formatStamp(stamp)}` : 'Awaiting first data fetch';
  } catch (err) {
    status.className = 'status error';
    status.textContent = `Could not load data: ${err.message}`;
    console.error(err);
  }
}

if (typeof document !== 'undefined') main();

// Exposed for the Node test harness (scripts/test-scoring.js); no effect in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeStandings, buildIndex, scoreTeam, scorePlayer, roundKey };
}
