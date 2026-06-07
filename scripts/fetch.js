#!/usr/bin/env node
/*
 * World Cup 2026 Sweeps — data fetch job.
 *
 * Runs in GitHub Actions on a cron. Calls API-Football, builds a compact
 * per-fixture + per-player events file, and writes:
 *   - public/data/matches.json
 *   - public/data/last-updated.txt
 *
 * Rate-limit friendly: pulls the fixture list once, then only fetches event
 * detail for fixtures that are live or have finished since the last run.
 * Settled fixtures are kept from the previous matches.json (merge), so a
 * busy match day stays well under the free tier (~100 req/day).
 *
 * On any hard failure it exits non-zero WITHOUT overwriting the existing
 * data, so the site keeps serving the last good snapshot (never blank).
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE = 1; // FIFA World Cup
const SEASON = 2026;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const PUBLIC_CONFIG_DIR = path.join(PUBLIC_DIR, 'config');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const TIMESTAMP_FILE = path.join(DATA_DIR, 'last-updated.txt');
const CONFIG_FILES = ['scoring.json', 'allocations.json', 'picks.json', 'motm.json'];

const KEY = process.env.API_FOOTBALL_KEY;

// Fixture status codes that mean "in play" (worth re-fetching every run).
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE']);
// Fixture status codes that mean "finished" (fetch detail once, then settle).
const FINISHED = new Set(['FT', 'AET', 'PEN', 'WO']);

function die(msg) {
  console.error(`[fetch] FATAL: ${msg}`);
  process.exit(1);
}

async function api(endpoint, params) {
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-apisports-key': KEY } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${endpoint} ${JSON.stringify(params)}`);
  }
  const json = await res.json();
  if (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors || {}).length) {
    throw new Error(`API errors for ${endpoint}: ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

function readPrevious() {
  try {
    const prev = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
    const map = new Map();
    for (const f of prev.fixtures || []) map.set(f.id, f);
    return map;
  } catch {
    return new Map();
  }
}

// Map an API round string to our progression keys (or null for group stage).
function roundKey(round) {
  const r = (round || '').toLowerCase();
  if (r.includes('round of 16') || r.includes('1/8')) return 'R16';
  if (r.includes('quarter')) return 'QF';
  if (r.includes('semi')) return 'SF';
  if (r.includes('3rd place') || r.includes('third place')) return null;
  if (r.includes('final')) return 'Final';
  return null; // group stage
}

// Build the per-player event summary for one fixture from the two detail
// endpoints. players stats give goals/assists/cards/minutes/position;
// events give own goals (not separated in the stats endpoint).
function summarisePlayers(playersResp, eventsResp) {
  const byId = new Map();

  for (const teamBlock of playersResp) {
    const teamId = teamBlock.team && teamBlock.team.id;
    for (const p of teamBlock.players || []) {
      const stat = (p.statistics && p.statistics[0]) || {};
      const games = stat.games || {};
      const goals = stat.goals || {};
      const cards = stat.cards || {};
      byId.set(p.player.id, {
        id: p.player.id,
        name: p.player.name,
        teamId,
        position: games.position || null, // "G" | "D" | "M" | "F"
        minutes: games.minutes || 0,
        goals: goals.total || 0,
        assists: goals.assists || 0,
        yellow: cards.yellow || 0,
        red: cards.red || 0,
        ownGoals: 0
      });
    }
  }

  // Own goals come from events (detail === "Own Goal"). The player belongs to
  // the conceding side; ensure they exist in the map even if absent above.
  for (const ev of eventsResp) {
    if (ev.type === 'Goal' && ev.detail === 'Own Goal' && ev.player && ev.player.id != null) {
      const id = ev.player.id;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: ev.player.name,
          teamId: ev.team && ev.team.id,
          position: null,
          minutes: 0,
          goals: 0,
          assists: 0,
          yellow: 0,
          red: 0,
          ownGoals: 0
        });
      }
      byId.get(id).ownGoals += 1;
    }
  }

  return Array.from(byId.values());
}

function shapeFixture(item, players) {
  const status = item.fixture.status.short;
  const home = item.teams.home;
  const away = item.teams.away;
  const gh = item.goals.home;
  const ga = item.goals.away;
  let winnerTeamId = null;
  if (home.winner === true) winnerTeamId = home.id;
  else if (away.winner === true) winnerTeamId = away.id;

  return {
    id: item.fixture.id,
    date: item.fixture.date,
    round: item.league.round,
    status,
    finished: FINISHED.has(status),
    homeTeam: { id: home.id, name: home.name, goals: gh },
    awayTeam: { id: away.id, name: away.name, goals: ga },
    winnerTeamId,
    players: players || []
  };
}

// Pages serves /public, but the admin edits config/ at the repo root. Mirror
// the four config files into public/config/ so the browser can read them
// same-origin. Done first, so a scoring/picks edit propagates even if the API
// call later fails.
function publishConfig() {
  fs.mkdirSync(PUBLIC_CONFIG_DIR, { recursive: true });
  for (const f of CONFIG_FILES) {
    const src = path.join(CONFIG_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(PUBLIC_CONFIG_DIR, f));
    }
  }
}

async function main() {
  if (!KEY) die('API_FOOTBALL_KEY is not set.');

  publishConfig();

  const prev = readPrevious();

  // 1) Full fixture list (1 request). If this fails, abort and keep old data.
  let fixtures;
  try {
    fixtures = await api('/fixtures', { league: LEAGUE, season: SEASON });
  } catch (e) {
    die(`could not fetch fixture list (${e.message}). Keeping previous data.`);
  }
  if (!fixtures.length) die('fixture list was empty. Keeping previous data.');

  let detailFetches = 0;
  const out = [];

  for (const item of fixtures) {
    const id = item.fixture.id;
    const status = item.fixture.status.short;
    const old = prev.get(id);

    // Decide whether we need event detail for this fixture.
    const isLive = LIVE.has(status);
    const isFinished = FINISHED.has(status);
    const alreadyDetailed =
      old && old.finished && Array.isArray(old.players) && old.players.length > 0;

    let players = (old && old.players) || [];

    if (isLive || (isFinished && !alreadyDetailed)) {
      try {
        const [playersResp, eventsResp] = await Promise.all([
          api('/fixtures/players', { fixture: id }),
          api('/fixtures/events', { fixture: id })
        ]);
        players = summarisePlayers(playersResp, eventsResp);
        detailFetches += 1;
      } catch (e) {
        // Keep whatever we had for this fixture; don't fail the whole run.
        console.warn(`[fetch] detail failed for fixture ${id}: ${e.message}`);
        players = (old && old.players) || [];
      }
    }

    out.push(shapeFixture(item, players));
  }

  out.sort((a, b) => new Date(a.date) - new Date(b.date));

  const payload = {
    league: LEAGUE,
    season: SEASON,
    generatedAt: new Date().toISOString(),
    fixtures: out
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MATCHES_FILE, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(TIMESTAMP_FILE, payload.generatedAt + '\n');

  console.log(
    `[fetch] ${out.length} fixtures written, ${detailFetches} detail fetch(es) this run.`
  );
}

main().catch((e) => die(e.stack || e.message));
