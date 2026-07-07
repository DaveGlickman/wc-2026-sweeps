#!/usr/bin/env node
/*
 * Man-of-the-Match editor. ESPN's feed has no MOTM, so we record the official
 * award (as published per match, e.g. on the FIFA app / Wikipedia) by hand into
 * config/motm.json — keyed by ESPN fixtureId (string) -> ESPN playerId (number).
 * Player scoring in public/app.js awards scoring.player.motm (+3) to whoever
 * picked that player. Called by scripts/motm.sh.
 *
 *   node scripts/motm-engine.js set   "<TeamA>" "<TeamB>" "<PlayerNameOrId>"
 *   node scripts/motm-engine.js unset "<TeamA>" "<TeamB>"
 *   node scripts/motm-engine.js list
 *
 * The fixture is found by matching the two team names (either order) among
 * FINISHED fixtures. The player is resolved by ESPN id, or by a case-insensitive
 * name fragment against that match's players (falling back to the full squad
 * list in public/data/players.json).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOTM = path.join(ROOT, 'config', 'motm.json');
const MOTM_PUBLIC = path.join(ROOT, 'public', 'config', 'motm.json');
const MATCHES = path.join(ROOT, 'public', 'data', 'matches.json');
const PLAYERS = path.join(ROOT, 'public', 'data', 'players.json');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function die(msg) { console.error(msg); process.exit(1); }

// Normalise a team name to a canonical token so "Turkey"/"Türkiye",
// "DR Congo"/"Congo DR", "Czech Republic"/"Czechia" etc. all match our data.
const ALIASES = {
  turkey: 'turkiye', turkiye: 'turkiye',
  'dr congo': 'congodr', 'congo dr': 'congodr', 'democratic republic of the congo': 'congodr',
  'czech republic': 'czechia', czechia: 'czechia',
  'bosnia and herzegovina': 'bosniaherzegovina', 'bosnia-herzegovina': 'bosniaherzegovina', bosnia: 'bosniaherzegovina',
  'united states': 'unitedstates', usa: 'unitedstates', 'united states of america': 'unitedstates',
  'south korea': 'southkorea', 'korea republic': 'southkorea',
  'ivory coast': 'ivorycoast', "cote d'ivoire": 'ivorycoast', "côte d'ivoire": 'ivorycoast'
};
function normTeam(name) {
  const base = String(name || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (ALIASES[base]) return ALIASES[base];
  return base.replace(/[^a-z0-9]/g, '');
}

function findFixture(matches, teamA, teamB) {
  const want = new Set([normTeam(teamA), normTeam(teamB)]);
  const hits = (matches.fixtures || []).filter((f) => {
    if (!f.finished) return false;
    const names = new Set([normTeam(f.homeTeam && f.homeTeam.name), normTeam(f.awayTeam && f.awayTeam.name)]);
    return want.size === 2 && [...want].every((w) => names.has(w));
  });
  if (hits.length === 0) die(`No FINISHED fixture found for "${teamA}" v "${teamB}".`);
  if (hits.length > 1) die(`Ambiguous: ${hits.length} fixtures match "${teamA}" v "${teamB}".`);
  return hits[0];
}

function resolvePlayer(fixture, input) {
  if (/^\d+$/.test(String(input))) return { id: String(input), name: null };
  const frag = String(input).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const pools = [(fixture.players || [])];
  const squads = readJSON(PLAYERS, null);
  if (squads) pools.push(Object.values(squads).flat ? [] : []); // players.json shape guard below
  // players.json is { teamId: [ {id,name,...} ] } or a flat array; handle both.
  let squadList = [];
  if (Array.isArray(squads)) squadList = squads;
  else if (squads && typeof squads === 'object') squadList = Object.values(squads).flat();
  pools.push(squadList);
  const seen = new Map();
  for (const pool of pools) {
    for (const p of pool) {
      if (p && p.id != null && norm(p.name).includes(frag)) seen.set(String(p.id), p.name);
    }
    if (seen.size) break; // prefer the match's own players over the full squad list
  }
  const hits = [...seen.entries()];
  if (hits.length === 0) die(`No player matching "${input}" in that match or the squads.`);
  if (hits.length > 1) die(`Ambiguous player "${input}": ${hits.map(([id, n]) => `${n} (${id})`).join(', ')}`);
  return { id: hits[0][0], name: hits[0][1] };
}

function load() {
  const m = readJSON(MOTM, { motm: {} });
  m.motm = m.motm || {};
  return m;
}
function save(m) {
  const out = JSON.stringify(m, null, 2) + '\n';
  fs.writeFileSync(MOTM, out);
  fs.writeFileSync(MOTM_PUBLIC, out);
}

function nameForPlayerId(matches, id) {
  for (const f of matches.fixtures || []) {
    const p = (f.players || []).find((x) => String(x.id) === String(id));
    if (p) return p.name;
  }
  return null;
}

function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  const matches = readJSON(MATCHES, { fixtures: [] });

  if (cmd === 'list') {
    const m = load();
    const entries = Object.entries(m.motm);
    if (!entries.length) { console.log('No MOTM entries yet.'); return; }
    console.log(`MOTM entries (${entries.length}):`);
    for (const [fid, pid] of entries) {
      const f = (matches.fixtures || []).find((x) => String(x.id) === String(fid));
      const label = f ? `${f.homeTeam.name} ${f.homeTeam.goals}-${f.awayTeam.goals} ${f.awayTeam.name}` : `fixture ${fid}`;
      console.log(`  ${label} -> ${nameForPlayerId(matches, pid) || 'player ' + pid} (${pid})`);
    }
    return;
  }

  if (cmd === 'set') {
    if (!a || !b || !c) die('usage: set "<TeamA>" "<TeamB>" "<PlayerNameOrId>"');
    const f = findFixture(matches, a, b);
    const pl = resolvePlayer(f, c);
    const m = load();
    m.motm[String(f.id)] = Number(pl.id);
    save(m);
    const label = `${f.homeTeam.name} ${f.homeTeam.goals}-${f.awayTeam.goals} ${f.awayTeam.name}`;
    console.log(`MOTM set: ${label} -> ${pl.name || nameForPlayerId(matches, pl.id) || pl.id} (${pl.id})`);
    return;
  }

  if (cmd === 'unset') {
    if (!a || !b) die('usage: unset "<TeamA>" "<TeamB>"');
    const f = findFixture(matches, a, b);
    const m = load();
    if (delete m.motm[String(f.id)]) { save(m); console.log(`MOTM cleared for fixture ${f.id}.`); }
    else console.log('No MOTM was set for that fixture.');
    return;
  }

  die(`Unknown command "${cmd}". Use: set | unset | list`);
}

main();
