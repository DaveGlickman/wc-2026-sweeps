#!/usr/bin/env node
/*
 * One-off validator the admin runs before picks lock (11 June).
 *
 * Checks each person's two player picks against the player's position from
 * ESPN's free API (no key needed):
 *   - index 0 (Pot A pick) must be an Attacker (position "F").
 *   - index 1 (Pot B pick) must be a Midfielder/Defender/Goalkeeper (M/D/G).
 *
 * Also flags people in picks.json with no matching name in allocations.json.
 *
 * Usage:  node scripts/verify-picks.js
 * Exits non-zero if any pick is invalid, so it can gate a workflow if wanted.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ATHLETE_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/athletes';
const ROOT = path.resolve(__dirname, '..');

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// Map ESPN position name/abbreviation to a single letter: G | D | M | F.
function posCode(position) {
  if (!position) return null;
  const name = String(position.name || '').toLowerCase();
  const abbr = String(position.abbreviation || '').toUpperCase();
  if (name.includes('keeper')) return 'G';
  if (name.includes('forward') || name.includes('striker')) return 'F';
  if (name.includes('midfield')) return 'M';
  if (name.includes('back') || name.includes('defen')) return 'D';
  if (abbr === 'G' || abbr === 'GK') return 'G';
  if (abbr.startsWith('F') || abbr === 'ST' || abbr === 'CF' || abbr === 'W') return 'F';
  if (abbr.startsWith('M')) return 'M';
  if (abbr.startsWith('D') || abbr === 'CB' || abbr === 'LB' || abbr === 'RB') return 'D';
  return null;
}

async function playerPosition(id) {
  const res = await fetch(`${ATHLETE_BASE}/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for player ${id}`);
  const json = await res.json();
  const athlete = json.athlete || json;
  if (!athlete || !(athlete.id || athlete.displayName)) return { found: false };
  return {
    found: true,
    name: athlete.displayName || athlete.fullName || athlete.name,
    code: posCode(athlete.position)
  };
}

async function main() {
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
      } else if (info.code !== 'F') {
        console.error(
          `X ${person.name}: Pot A pick ${info.name} is "${info.code}", must be an Attacker (F)`
        );
        problems++;
      } else {
        console.log(`ok ${person.name}: Pot A ${info.name} (${info.code})`);
      }
    }

    if (potB) {
      const info = await playerPosition(potB.id);
      if (!info.found) {
        console.error(`X ${person.name}: Pot B player id ${potB.id} not found`);
        problems++;
      } else if (!['M', 'D', 'G'].includes(info.code)) {
        console.error(
          `X ${person.name}: Pot B pick ${info.name} is "${info.code}", must be Mid/Def/GK`
        );
        problems++;
      } else {
        console.log(`ok ${person.name}: Pot B ${info.name} (${info.code})`);
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
