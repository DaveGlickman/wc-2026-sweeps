#!/usr/bin/env node
/*
 * World Cup 2026 Sweeps — deterministic draw.
 *
 * Reads config/entrants.json (paid entrants only) and config/pots.json, then
 * assigns every paid entrant exactly one Pot A team and one Pot B team, with no
 * team used twice. The result is written to config/allocations.json in the
 * shape the front-end already expects, and a readable summary is printed.
 *
 * The draw is FULLY DETERMINISTIC from a seed given on the command line:
 *
 *     node scripts/draw.js --seed 04-11-23-31-44-09
 *
 * The seed feeds a seeded PRNG (cyrb128 -> sfc32), never Math.random(), so
 * re-running with the same seed and the same entrants/pots always produces a
 * byte-identical allocations.json. Anyone can therefore verify the draw was
 * fair by re-running it with the publicly-agreed seed (e.g. a specific
 * National Lottery draw, entered as a single string).
 *
 * No npm dependencies; Node 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRANTS_FILE = path.join(ROOT, 'config', 'entrants.json');
const POTS_FILE = path.join(ROOT, 'config', 'pots.json');
const ALLOCATIONS_FILE = path.join(ROOT, 'config', 'allocations.json');

function die(msg) {
  console.error(`[draw] ERROR: ${msg}`);
  process.exit(1);
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`could not read ${path.relative(ROOT, file)}: ${e.message}`);
  }
}

// ---- seeded PRNG ----------------------------------------------------------
// cyrb128 hashes the seed string into four 32-bit words; sfc32 turns those into
// a fast, well-distributed stream of floats in [0, 1). Both are standard,
// public-domain algorithms — identical inputs always give an identical stream.

function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const [a, b, c, d] = cyrb128(seed);
  return sfc32(a, b, c, d);
}

// Fisher–Yates on a copy, driven entirely by the seeded rng.
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ---- args -----------------------------------------------------------------

function parseSeed(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') return argv[i + 1];
    if (a.startsWith('--seed=')) return a.slice('--seed='.length);
  }
  return null;
}

// ---- validation -----------------------------------------------------------

function validatePot(pot, label) {
  if (!Array.isArray(pot) || !pot.length) die(`pots.json ${label} is empty.`);
  const seen = new Set();
  for (const t of pot) {
    if (t == null || t.id == null) die(`pots.json ${label} has an entry with no id.`);
    const id = String(t.id);
    if (seen.has(id)) die(`pots.json ${label} has a duplicate team id "${id}".`);
    seen.add(id);
  }
  return seen;
}

// ---- main -----------------------------------------------------------------

function main() {
  const seed = parseSeed(process.argv.slice(2));
  if (!seed) {
    die('no seed given. Usage: node scripts/draw.js --seed <seed>\n' +
        '       e.g. node scripts/draw.js --seed 04-11-23-31-44-09');
  }

  const entrantsDoc = load(ENTRANTS_FILE);
  const pots = load(POTS_FILE);

  const potA = pots.potA || [];
  const potB = pots.potB || [];
  const idsA = validatePot(potA, 'potA');
  const idsB = validatePot(potB, 'potB');
  for (const id of idsA) {
    if (idsB.has(id)) die(`team id "${id}" appears in both potA and potB.`);
  }

  // Paid entrants only, in a stable order (by id, then name) so the result
  // depends on the seed, not on how entrants.json happens to be ordered.
  const paid = (entrantsDoc.people || [])
    .filter((p) => p && p.paid === true)
    .sort((x, y) =>
      String(x.id || '').localeCompare(String(y.id || '')) ||
      String(x.name || '').localeCompare(String(y.name || '')));

  if (!paid.length) die('no paid entrants in entrants.json (need at least one with "paid": true).');

  const n = paid.length;
  if (n > potA.length) die(`${n} paid entrants but Pot A only has ${potA.length} teams.`);
  if (n > potB.length) die(`${n} paid entrants but Pot B only has ${potB.length} teams.`);

  const rng = makeRng(seed);
  const drawnA = shuffle(potA, rng);
  const drawnB = shuffle(potB, rng);

  const people = paid.map((entrant, i) => ({
    name: entrant.name,
    id: entrant.id,
    teams: [
      { id: String(drawnA[i].id), name: drawnA[i].name || null },
      { id: String(drawnB[i].id), name: drawnB[i].name || null }
    ]
  }));

  const out = {
    _comment:
      `Generated by scripts/draw.js with --seed "${seed}". Do not edit by hand — ` +
      `re-run the draw to reproduce. Only paid entrants (config/entrants.json) are included.`,
    seed,
    people
  };

  fs.writeFileSync(ALLOCATIONS_FILE, JSON.stringify(out, null, 2) + '\n');

  // Readable summary.
  const pad = (s, w) => String(s).padEnd(w);
  const nameW = Math.max(8, ...people.map((p) => p.name.length));
  const aW = Math.max(8, ...people.map((p) => (p.teams[0].name || p.teams[0].id).length));
  console.log(`\nWorld Cup 2026 Sweeps — draw`);
  console.log(`Seed: ${seed}`);
  console.log(`Paid entrants drawn: ${n}\n`);
  console.log(`${pad('Entrant', nameW)}  ${pad('Pot A', aW)}  Pot B`);
  console.log(`${'-'.repeat(nameW)}  ${'-'.repeat(aW)}  ${'-'.repeat(8)}`);
  for (const p of people) {
    const a = p.teams[0].name || p.teams[0].id;
    const b = p.teams[1].name || p.teams[1].id;
    console.log(`${pad(p.name, nameW)}  ${pad(a, aW)}  ${b}`);
  }
  console.log(`\nWrote ${path.relative(ROOT, ALLOCATIONS_FILE)}.`);
  console.log('Next: fill config/picks.json (same names), commit, push.\n');
}

main();
