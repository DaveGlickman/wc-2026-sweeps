#!/usr/bin/env node
/*
 * World Cup 2026 Sweeps — data fetch job (ESPN free JSON API).
 *
 * Runs in GitHub Actions on a cron. Reads ESPN's public soccer API — no key,
 * no payment — and builds a compact per-fixture + per-player events file:
 *   - public/data/matches.json
 *   - public/data/last-updated.txt
 *
 * Why ESPN: the free API-Football tier does not cover season 2026. ESPN's
 * site.api.espn.com endpoints are free, return structured JSON (goals with
 * scorer AND assister, cards, lineups), and are reachable from datacenter IPs
 * (GitHub Actions), unlike HTML scraping of livescore-style sites.
 *
 * Output shape is identical to the previous fetcher, so the front-end
 * (public/app.js), the scoring math, and the deployed site are unchanged.
 *
 * IDs are ESPN ids (strings). The draw config (allocations.json / picks.json)
 * therefore uses ESPN team/player ids — see scripts/list-squads.js.
 *
 * Rate-friendly: each run only fetches scoreboards for the live window
 * (yesterday/today/tomorrow) plus any dates not seen before, and only fetches
 * per-match detail for fixtures that are live or have just finished. Settled
 * fixtures are kept from the previous matches.json (merge). On any hard
 * failure it exits non-zero WITHOUT overwriting data, so the site keeps
 * serving the last good snapshot.
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEAGUE_SLUG = process.env.WC_LEAGUE || 'fifa.world';
const BASE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE_SLUG}`;
const SEASON = 2026;

// Tournament window (UTC dates, inclusive). Override with
// WC_DATES="20221218,20221213" to test against finished matches.
const WINDOW_START = '2026-06-11';
const WINDOW_END = '2026-07-19';

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const PUBLIC_CONFIG_DIR = path.join(PUBLIC_DIR, 'config');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const TIMESTAMP_FILE = path.join(DATA_DIR, 'last-updated.txt');
// NOTE: entrants.json is deliberately NOT mirrored — it holds amount/datePaid.
// The public site reads name+paid only via public/data/roster.json (build-roster.js).
const CONFIG_FILES = ['scoring.json', 'allocations.json', 'picks.json', 'motm.json', 'pots.json', 'backend.json', 'preseason.json', 'peanuts-manual.json', 'stats-manual.json'];

const UA = 'Mozilla/5.0 (wc-2026-sweeps data fetcher)';

// Front-end status codes (kept identical to the old API-Football scheme).
const LIVE_CODES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE']);
const FINISHED_CODES = new Set(['FT', 'AET', 'PEN', 'WO']);

function die(msg) {
  console.error(`[fetch] FATAL: ${msg}`);
  process.exit(1);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---- date helpers ---------------------------------------------------------

// 'YYYY-MM-DD' for each day in [start, end] inclusive (UTC).
function dateRange(start, end) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const compactDate = (key) => key.replace(/-/g, ''); // 'YYYY-MM-DD' -> 'YYYYMMDD'
const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

// ---- mapping helpers ------------------------------------------------------

// ESPN status -> our code + finished/live flags.
function classifyStatus(typeObj) {
  const t = typeObj || {};
  const name = String(t.name || '').toUpperCase();
  const state = String(t.state || '').toLowerCase();
  if (t.completed === true || state === 'post') {
    if (name.includes('PEN')) return { code: 'PEN', finished: true };
    if (name.includes('AET') || name.includes('EXTRA')) return { code: 'AET', finished: true };
    return { code: 'FT', finished: true };
  }
  if (state === 'in') {
    if (name.includes('HALFTIME')) return { code: 'HT', finished: false };
    if (name.includes('SHOOT') || name.includes('PEN')) return { code: 'P', finished: false };
    return { code: 'LIVE', finished: false };
  }
  return { code: 'NS', finished: false };
}

// ESPN position name/abbr -> 'G' | 'D' | 'M' | 'F' (front-end clean-sheet uses G/D).
function posCode(positionObj) {
  const p = positionObj || {};
  const name = String(p.name || '').toLowerCase();
  const abbr = String(p.abbreviation || '').toUpperCase();
  if (name.includes('keeper') || abbr === 'G' || abbr === 'GK') return 'G';
  if (name.includes('forward') || name.includes('striker') || name.includes('winger')) return 'F';
  if (name.includes('midfield')) return 'M';
  if (name.includes('back') || name.includes('defender') || name.includes('sweeper')) return 'D';
  // Fall back to abbreviation families.
  if (['CF', 'ST', 'SS', 'LW', 'RW', 'F', 'W', 'LF', 'RF'].includes(abbr)) return 'F';
  if (['DM', 'CM', 'AM', 'CDM', 'CAM', 'LM', 'RM', 'LDM', 'RDM', 'M'].includes(abbr)) return 'M';
  if (['CB', 'LB', 'RB', 'LWB', 'RWB', 'WB', 'SW', 'CD', 'LCB', 'RCB', 'D'].includes(abbr)) return 'D';
  return null;
}

// Normalise an ESPN calendar stage label to one app.js roundKey() understands.
function labelFromCalendarLabel(raw) {
  const l = String(raw).toLowerCase();
  if (l.includes('32')) return 'Round of 32';
  if (l.includes('16')) return 'Round of 16';
  if (l.includes('quarter')) return 'Quarter-finals';
  if (l.includes('3rd') || l.includes('third')) return '3rd Place';
  if (l.includes('semi')) return 'Semi-finals';
  if (l.includes('final')) return 'Final';
  return 'Group Stage';
}

// Map a fixture date to a round label. The 3rd-place and semi-final date
// ranges overlap, so when several stages match a date we pick the most
// specific one (narrowest range) — that's the 3rd-place match on its day.
// calendar = array of { label, start, end } collected from scoreboards.
function roundLabelFor(iso, calendar) {
  const t = new Date(iso).getTime();
  let best = null;
  for (const c of calendar) {
    if (t >= c.start && t <= c.end) {
      const span = c.end - c.start;
      if (!best || span < best.span) best = { span, label: c.label };
    }
  }
  return best ? labelFromCalendarLabel(best.label) : 'Group Stage';
}

function collectCalendar(scoreboard, into) {
  const lg = (scoreboard.leagues || [])[0] || {};
  for (const c of lg.calendar || []) {
    for (const e of c.entries || []) {
      const start = Date.parse(e.startDate);
      const end = Date.parse(e.endDate);
      if (!Number.isNaN(start) && !Number.isNaN(end)) {
        into.push({ label: String(e.label || ''), start, end });
      }
    }
  }
}

// Shape one ESPN scoreboard event into our fixture (without player detail).
function shapeFixture(ev, calendar) {
  const comp = (ev.competitions || [])[0] || {};
  const status = classifyStatus((ev.status || {}).type || (comp.status || {}).type);
  const competitors = comp.competitors || [];
  const find = (ha) => competitors.find((c) => c.homeAway === ha) || {};
  const home = find('home');
  const away = find('away');
  const score = (c) => {
    const s = c.score;
    return s == null || s === '' ? null : Number(s);
  };
  const teamOf = (c) => ({
    id: c.team && String(c.team.id),
    name: c.team && (c.team.displayName || c.team.name),
    goals: status.finished || LIVE_CODES.has(status.code) ? score(c) : null
  });
  let winnerTeamId = null;
  if (home.winner === true) winnerTeamId = home.team && String(home.team.id);
  else if (away.winner === true) winnerTeamId = away.team && String(away.team.id);

  return {
    id: String(ev.id),
    date: ev.date,
    round: roundLabelFor(ev.date, calendar),
    status: status.code,
    finished: FINISHED_CODES.has(status.code),
    homeTeam: teamOf(home),
    awayTeam: teamOf(away),
    winnerTeamId,
    players: []
  };
}

// Build per-player events for one fixture from its ESPN summary.
function buildPlayers(summary) {
  const byId = new Map();

  // 1) Seed from line-ups: position + whether they played (for clean sheets).
  for (const group of summary.rosters || []) {
    const teamId = group.team && String(group.team.id);
    for (const entry of group.roster || []) {
      const a = entry.athlete || {};
      if (a.id == null) continue;
      const id = String(a.id);
      const played = entry.starter === true || entry.subbedIn === true;
      byId.set(id, {
        id,
        name: a.displayName || a.shortName || null,
        teamId,
        position: posCode(entry.position),
        minutes: played ? 90 : 0,
        goals: 0,
        assists: 0,
        yellow: 0,
        red: 0,
        ownGoals: 0
      });
    }
  }

  const ensure = (a, teamId) => {
    const id = String(a.id);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: a.displayName || a.shortName || null,
        teamId: teamId || null,
        position: null,
        minutes: 0,
        goals: 0,
        assists: 0,
        yellow: 0,
        red: 0,
        ownGoals: 0
      });
    }
    return byId.get(id);
  };

  // 2) Tally goals / assists / cards / own goals from key events.
  for (const e of summary.keyEvents || []) {
    if (e.shootout === true) continue; // exclude penalty-shootout kicks
    const text = String((e.type || {}).text || '').toLowerCase();
    const parts = e.participants || [];
    if (!parts.length) continue;
    const teamId = e.team && String(e.team.id);
    const first = parts[0] && parts[0].athlete;
    if (!first || first.id == null) continue;

    if (text.includes('own goal')) {
      ensure(first, teamId).ownGoals += 1;
    } else if (e.scoringPlay === true || text.includes('goal') || text === 'penalty - scored') {
      ensure(first, teamId).goals += 1;
      const second = parts[1] && parts[1].athlete;
      if (second && second.id != null) ensure(second, teamId).assists += 1;
    } else if (text.includes('red')) {
      ensure(first, teamId).red += 1;
    } else if (text.includes('yellow')) {
      ensure(first, teamId).yellow += 1;
    }
  }

  return Array.from(byId.values());
}

// ---- persistence ----------------------------------------------------------

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
  } catch {
    return { fixtures: [] };
  }
}

// Pages serves /public, but the admin edits config/ at the repo root. Mirror
// the config files into public/config/ so the browser reads them same-origin.
function publishConfig() {
  fs.mkdirSync(PUBLIC_CONFIG_DIR, { recursive: true });
  for (const f of CONFIG_FILES) {
    const src = path.join(CONFIG_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PUBLIC_CONFIG_DIR, f));
  }
}

async function main() {
  publishConfig();

  const prev = readPrevious();
  const prevById = new Map((prev.fixtures || []).map((f) => [f.id, f]));
  const prevDates = new Set((prev.fixtures || []).map((f) => dayKey(f.date)));

  // Which dates to (re)fetch this run.
  const override = (process.env.WC_DATES || '').trim();
  const allDates = override
    ? override.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (s.includes('-') ? s : `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`))
    : dateRange(WINDOW_START, WINDOW_END);

  const today = new Date().toISOString().slice(0, 10);
  const liveWindow = new Set([-1, 0, 1].map((delta) => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }));

  const calendar = [];
  const fixturesByDate = new Map(); // date -> shaped fixtures
  let scoreboardFetches = 0;

  for (const date of allDates) {
    const known = prevDates.has(date);
    const mustFetch = override ? true : (liveWindow.has(date) || !known);

    if (!mustFetch) continue; // settled/known future date: reuse prev below

    try {
      const sb = await getJSON(`${BASE}/scoreboard?dates=${compactDate(date)}`);
      scoreboardFetches += 1;
      collectCalendar(sb, calendar);
      const events = sb.events || [];
      if (events.length) {
        fixturesByDate.set(date, events.map((ev) => shapeFixture(ev, calendar)));
      }
    } catch (e) {
      console.warn(`[fetch] scoreboard ${date} failed: ${e.message}`);
      // Fall through; if we had prev fixtures for this date they're reused below.
    }
  }

  // Ensure we always have the stage calendar (even on a run that fetched no
  // new scoreboards), so round labels stay correct for every fixture.
  if (!calendar.length) {
    try {
      const sb = await getJSON(`${BASE}/scoreboard?dates=${compactDate(WINDOW_START)}`);
      collectCalendar(sb, calendar);
    } catch (e) {
      console.warn(`[fetch] calendar refresh failed: ${e.message}`);
    }
  }

  // Assemble the full fixture list: freshly-fetched dates win; everything else
  // is carried over from the previous file.
  const out = [];
  const usedFresh = new Set();
  for (const [, list] of fixturesByDate) {
    for (const f of list) {
      const old = prevById.get(f.id);
      if (old && Array.isArray(old.players)) f.players = old.players;
      out.push(f);
      usedFresh.add(f.id);
    }
  }
  for (const f of prev.fixtures || []) {
    if (!usedFresh.has(f.id)) out.push(f);
  }

  // Re-stamp every fixture's round from the current calendar (fixes labels on
  // carried-over fixtures and absorbs any ESPN rescheduling).
  if (calendar.length) {
    for (const f of out) f.round = roundLabelFor(f.date, calendar);
  }

  if (!out.length) die('no fixtures available (and no previous data). Keeping old file.');

  // Detail pass: fetch line-ups + events for live or newly-finished fixtures.
  let detailFetches = 0;
  for (const f of out) {
    const isLive = LIVE_CODES.has(f.status);
    const isFinished = FINISHED_CODES.has(f.status);
    const detailed = Array.isArray(f.players) && f.players.length > 0;
    if (isLive || (isFinished && !detailed)) {
      try {
        const summary = await getJSON(`${BASE}/summary?event=${f.id}`);
        f.players = buildPlayers(summary);
        detailFetches += 1;
      } catch (e) {
        console.warn(`[fetch] detail failed for fixture ${f.id}: ${e.message}`);
      }
    }
  }

  out.sort((a, b) => new Date(a.date) - new Date(b.date));

  const payload = {
    league: LEAGUE_SLUG,
    season: SEASON,
    generatedAt: new Date().toISOString(),
    fixtures: out
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MATCHES_FILE, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(TIMESTAMP_FILE, payload.generatedAt + '\n');

  console.log(
    `[fetch] ${out.length} fixtures written; ` +
    `${scoreboardFetches} scoreboard + ${detailFetches} detail fetch(es) this run.`
  );
}

main().catch((e) => die(e.stack || e.message));
