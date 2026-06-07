#!/usr/bin/env node
/*
 * One-off validator the admin runs before picks lock (11 June).
 *
 * Checks each person's two player picks against the player's position from
 * API-Football:
 *   - index 0 (Pot A pick) must be an Attacker (position "F").
 *   - index 1 (Pot B pick) must be a Midfielder/Defender/Goalkeeper (M/D/G).
 *
 * Also flags people in picks.json with no matching name in allocations.json.
 *
 * Usage:  API_FOOTBALL_KEY=xxx node scripts/verify-picks.js
 * Exits non-zero if any pick is invalid, so it can gate a workflow if wanted.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE = 1;
const SEASON = 2026;
const ROOT = path.resolve(__dirname, '..');
const KEY = process.env.API_FOOTBALL_KEY;

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

async function playerPosition(id) {
  const url = new URL(API_BASE + '/players');
  url.searchParams.set('id', id);
  url.searchParams.set('league', LEAGUE);
  url.searchParams.set('season', SEASON);
  const res = await fetch(url, { headers: { 'x-apisports-key': KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for player ${id}`);
  const json = await res.json();
  const row = (json.response || [])[0];
  if (!row) return { found: false };
  const stat = (row.statistics || [])[0] || {};
  return {
    found: true,
    name: row.player && row.player.name,
    position: (stat.games && stat.games.position) || (row.player && row.player.position) || null
  };
}

async function main() {
  if (!KEY) {
    console.error('API_FOOTBALL_KEY is not set.');
    process.exit(1);
  }

  const picks = load('config/picks.json');
  const allocations = load('config/allocations.json');
  const allocNames = new Set((allocations.people || []).map((p) => p.name));

  let problems = 0;

  for (const person of picks.people || []) {
    if (!allocNames.has(person.name)) {
      console.warn(`! "${person.name}" in picks.json has no match in allocations.json`);
      problems++;
    }

    const [potA, potB] = person.players || [];

    if (potA) {
      const info = await playerPosition(potA.id);
      if (!info.found) {
        console.error(`X ${person.name}: Pot A player id ${potA.id} not found`);
        problems++;
      } else if (info.position !== 'F' && info.position !== 'Attacker') {
        console.error(
          `X ${person.name}: Pot A pick ${info.name} is "${info.position}", must be an Attacker (F)`
        );
        problems++;
      } else {
        console.log(`ok ${person.name}: Pot A ${info.name} (${info.position})`);
      }
    }

    if (potB) {
      const info = await playerPosition(potB.id);
      const allowed = ['M', 'D', 'G', 'Midfielder', 'Defender', 'Goalkeeper'];
      if (!info.found) {
        console.error(`X ${person.name}: Pot B player id ${potB.id} not found`);
        problems++;
      } else if (!allowed.includes(info.position)) {
        console.error(
          `X ${person.name}: Pot B pick ${info.name} is "${info.position}", must be Mid/Def/GK`
        );
        problems++;
      } else {
        console.log(`ok ${person.name}: Pot B ${info.name} (${info.position})`);
      }
    }
  }

  if (problems) {
    console.error(`\n${problems} problem(s) found.`);
    process.exit(1);
  }
  console.log('\nAll picks valid.');
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
