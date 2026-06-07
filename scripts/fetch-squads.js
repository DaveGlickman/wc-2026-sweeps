#!/usr/bin/env node
/*
 * World Cup 2026 Sweeps — squad fetcher (ESPN free JSON API).
 *
 * Builds public/data/players.json — the list that powers the pick dropdowns on
 * the self-serve draw page and is the source of truth for position validation
 * in the backend. Shape:
 *
 *   { generatedAt, players: [ { id, name, team, teamId, position } ] }
 *
 * `position` is the GROUPED bucket the picks care about:
 *   "Attacker"    -> the Pot A pick (index 0)
 *   "Mid/Def/GK"  -> the Pot B pick (index 1)
 *
 * Teams come from config/pots.json (all 48 nations, ESPN ids). Squads change
 * rarely, so this is rate-heavy (one request per team): it SKIPS work when a
 * non-empty players.json already exists, unless WC_FORCE_SQUADS=1 is set. Run
 * it once via "workflow_dispatch" with WC_FORCE_SQUADS=1 near the tournament.
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEAGUE_SLUG = process.env.WC_LEAGUE || 'fifa.world';
const BASE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE_SLUG}`;
const UA = 'Mozilla/5.0 (wc-2026-sweeps squad fetcher)';

const ROOT = path.resolve(__dirname, '..');
const POTS_FILE = path.join(ROOT, 'config', 'pots.json');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

function warn(msg) { console.warn(`[squads] ${msg}`); }

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ESPN position name/abbr -> grouped bucket used by the picks.
function positionGroup(positionObj) {
  const p = positionObj || {};
  const name = String(p.name || '').toLowerCase();
  const abbr = String(p.abbreviation || '').toUpperCase();
  const isForward =
    name.includes('forward') || name.includes('striker') || name.includes('winger') ||
    ['CF', 'ST', 'SS', 'LW', 'RW', 'F', 'W', 'LF', 'RF'].includes(abbr);
  return isForward ? 'Attacker' : 'Mid/Def/GK';
}

// ESPN roster shapes vary; collect athletes from the common layouts.
function athletesFromRoster(doc) {
  const out = [];
  const push = (a) => { if (a && a.athlete) out.push(a); else if (a && a.id) out.push({ athlete: a, position: a.position }); };
  const list = doc.athletes || (doc.team && doc.team.athletes) || [];
  for (const node of list) {
    if (Array.isArray(node.items)) node.items.forEach(push); // grouped by position
    else push(node);                                          // flat list
  }
  return out;
}

async function main() {
  const force = process.env.WC_FORCE_SQUADS === '1';
  if (!force && fs.existsSync(PLAYERS_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
      if (existing && Array.isArray(existing.players) && existing.players.length) {
        console.log(`[squads] players.json already has ${existing.players.length} players; skipping (set WC_FORCE_SQUADS=1 to refetch).`);
        return;
      }
    } catch { /* fall through and rebuild */ }
  }

  let pots;
  try {
    pots = JSON.parse(fs.readFileSync(POTS_FILE, 'utf8'));
  } catch (e) {
    warn(`could not read config/pots.json: ${e.message}; nothing to do.`);
    return;
  }
  const teams = [...(pots.potA || []), ...(pots.potB || [])]
    .filter((t) => t && t.id != null)
    .map((t) => ({ id: String(t.id), name: t.name || null }));

  const players = [];
  const seen = new Set();
  let okTeams = 0;

  for (const team of teams) {
    try {
      const doc = await getJSON(`${BASE}/teams/${team.id}/roster`);
      const teamName = (doc.team && (doc.team.displayName || doc.team.name)) || team.name;
      const roster = athletesFromRoster(doc);
      let added = 0;
      for (const entry of roster) {
        const a = entry.athlete || {};
        if (a.id == null) continue;
        const id = String(a.id);
        if (seen.has(id)) continue;
        seen.add(id);
        players.push({
          id,
          name: a.displayName || a.shortName || a.fullName || null,
          team: teamName,
          teamId: team.id,
          position: positionGroup(entry.position || a.position)
        });
        added++;
      }
      if (added) okTeams++;
      else warn(`no players parsed for team ${team.name || team.id}`);
    } catch (e) {
      warn(`roster failed for team ${team.name || team.id}: ${e.message}`);
    }
  }

  if (!players.length) {
    warn('built an empty squad list; keeping any existing players.json untouched.');
    return;
  }

  players.sort((a, b) =>
    String(a.team || '').localeCompare(String(b.team || '')) ||
    String(a.name || '').localeCompare(String(b.name || '')));

  const payload = { generatedAt: new Date().toISOString(), players };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[squads] wrote ${players.length} players from ${okTeams}/${teams.length} teams.`);
}

main().catch((e) => { console.error(`[squads] FATAL: ${e.stack || e.message}`); process.exit(1); });
