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
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ENTRANTS_FILE = path.join(ROOT, 'config', 'entrants.json');
const POTS_FILE = path.join(ROOT, 'config', 'pots.json');
const ALLOCATIONS_FILE = path.join(ROOT, 'config', 'allocations.json');
const PRIVATE_DIR = path.join(ROOT, 'private');
const SHEET_FILE = path.join(PRIVATE_DIR, 'entrants-sheet.tsv');
const LINKS_FILE = path.join(PRIVATE_DIR, 'links.txt');

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

// A team's seed (1 = strongest). Missing/invalid seeds rank last so they end up
// in the undrawn surplus rather than displacing a properly-seeded strong team.
function seedOf(t) {
  const s = Number(t.seed);
  return Number.isFinite(s) ? s : Number.MAX_SAFE_INTEGER;
}

// Pick the n teams from a pot that actually go into the draw.
// Teams are ranked by seed, strongest first, and the top n are taken — so the
// undrawn surplus is always the LOWEST seeds (PROTECT TOP SEEDS). Any id in
// protectedIds is force-kept: if the seed cut would drop it, it is swapped in
// for the lowest-seeded otherwise-selected team that isn't itself protected
// (HARD REQUIREMENT, e.g. South Africa is never left undrawn). Deterministic:
// no rng here, so WHICH teams are in depends only on seeds + count.
function selectForDraw(pot, n, protectedIds, label) {
  const ranked = pot.slice().sort((a, b) => seedOf(a) - seedOf(b));
  const selected = ranked.slice(0, n);
  const selectedIds = new Set(selected.map((t) => String(t.id)));
  for (const pid of protectedIds) {
    if (selectedIds.has(pid)) continue;
    const team = ranked.find((t) => String(t.id) === pid);
    if (!team) continue; // protected id isn't in this pot — ignore here
    let swapped = false;
    for (let i = selected.length - 1; i >= 0; i--) {
      if (!protectedIds.includes(String(selected[i].id))) {
        selectedIds.delete(String(selected[i].id));
        selected[i] = team;
        selectedIds.add(pid);
        swapped = true;
        break;
      }
    }
    if (!swapped) die(`${label}: cannot keep protected team ${pid} — too few unprotected slots for ${n} players.`);
  }
  return selected;
}

// ---- args -----------------------------------------------------------------

function parseFlag(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(`--${name}=`.length);
  }
  return null;
}

const parseSeed = (argv) => parseFlag(argv, 'seed');

// Random, unguessable per-person token. NOT derived from the seed: tokens are
// secrets, and the seed is meant to be public for draw verification. So a
// re-run reproduces the same teams but issues fresh tokens — which is fine,
// because tokens never enter the committed/verifiable allocations.json.
function makeToken() {
  return crypto.randomBytes(16).toString('base64url'); // 22 url-safe chars
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
  const argv = process.argv.slice(2);
  const seed = parseSeed(argv);
  if (!seed) {
    die('no seed given. Usage: node scripts/draw.js --seed <seed> [--base-url <pages-url>]\n' +
        '       e.g. node scripts/draw.js --seed 04-11-23-31-44-09 --base-url https://me.github.io/wc-2026-sweeps');
  }
  const baseUrl = (parseFlag(argv, 'base-url') || 'https://YOUR-PAGES-URL').replace(/\/+$/, '');

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

  const protectedIds = (pots.alwaysInclude || []).map(String);

  const rng = makeRng(seed);
  // Two stages. 1) Deterministically (seeds only) decide WHICH teams are in the
  // draw: the strongest n per pot, with protected teams force-kept. 2) Use the
  // seeded rng to decide WHO gets which of those teams. Same seed + same paid
  // count -> identical allocation, re-runnable to verify.
  const drawnA = shuffle(selectForDraw(potA, n, protectedIds, 'potA'), rng);
  const drawnB = shuffle(selectForDraw(potB, n, protectedIds, 'potB'), rng);

  const people = paid.map((entrant, i) => ({
    name: entrant.name,
    id: entrant.id,
    teams: [
      { id: String(drawnA[i].id), name: drawnA[i].name || null },
      { id: String(drawnB[i].id), name: drawnB[i].name || null }
    ]
  }));

  // Per-person secrets for the self-serve reveal. These NEVER go in
  // allocations.json (committed/public) — only into the gitignored private/
  // files for pasting into the private Sheet and DMing personal links.
  const secrets = people.map((p) => ({ ...p, token: makeToken() }));

  const out = {
    _comment:
      `Generated by scripts/draw.js with --seed "${seed}". Do not edit by hand — ` +
      `re-run the draw to reproduce. Only paid entrants (config/entrants.json) are included.`,
    seed,
    people
  };

  fs.writeFileSync(ALLOCATIONS_FILE, JSON.stringify(out, null, 2) + '\n');

  // Private, gitignored outputs (tokens live here only — never committed).
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });

  // 1) Tab-separated rows to paste under the "Entrants" header in the Sheet:
  //    name  id  token  teamA_id  teamB_id  submitted  pickFwd_id  pickOther_id
  const sheetHeader = ['name', 'id', 'token', 'teamA_id', 'teamB_id', 'submitted', 'pickFwd_id', 'pickOther_id'];
  const sheetRows = secrets.map((p) =>
    [p.name, p.id, p.token, p.teams[0].id, p.teams[1].id, 'FALSE', '', ''].join('\t'));
  fs.writeFileSync(SHEET_FILE, [sheetHeader.join('\t'), ...sheetRows].join('\n') + '\n');

  // 2) One personal reveal link per person, for the admin to DM individually.
  const links = secrets.map((p) => `${p.name}\t${baseUrl}/draw.html?t=${p.token}`);
  fs.writeFileSync(LINKS_FILE, links.join('\n') + '\n');

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
  console.log(`\nWrote ${path.relative(ROOT, ALLOCATIONS_FILE)} (committed/public — teams only).`);
  console.log(`Wrote ${path.relative(ROOT, SHEET_FILE)} — paste under the Sheet "Entrants" header.`);
  console.log(`Wrote ${path.relative(ROOT, LINKS_FILE)} — DM each person their own link.`);
  if (baseUrl === 'https://YOUR-PAGES-URL') {
    console.log('NOTE: pass --base-url <your-pages-url> to bake real links into links.txt.');
  }
  console.log('\nThe private/ folder is gitignored — never commit tokens to a public repo.\n');
}

main();
