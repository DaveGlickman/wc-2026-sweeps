#!/usr/bin/env node
/*
 * Manual side of the auto peanut engine. Edits config/peanuts-manual.json (and
 * its public/ mirror) for the bits the match feed can't supply, and can print
 * the computed outstanding board. Called by scripts/peanut.sh.
 *
 *   node scripts/peanut-engine.js done   <Name>
 *   node scripts/peanut-engine.js undo   <Name>
 *   node scripts/peanut-engine.js miss   <PlayerOrId>
 *   node scripts/peanut-engine.js unmiss <PlayerOrId>
 *   node scripts/peanut-engine.js adjust <Name> <+/-n>
 *   node scripts/peanut-engine.js list
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANUAL = path.join(ROOT, 'config', 'peanuts-manual.json');
const MANUAL_PUBLIC = path.join(ROOT, 'public', 'config', 'peanuts-manual.json');
const ALLOCATIONS = path.join(ROOT, 'config', 'allocations.json');
const PICKS = path.join(ROOT, 'config', 'picks.json');
const POTS = path.join(ROOT, 'config', 'pots.json');
const MATCHES = path.join(ROOT, 'public', 'data', 'matches.json');

const { buildIndex, computePeanutsFor } = require(path.join(ROOT, 'public', 'app.js'));

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function die(msg) { console.error(msg); process.exit(1); }

function knownNames() {
  return (readJSON(ALLOCATIONS).people || []).map((p) => p.name);
}

function resolveName(input) {
  const names = knownNames();
  const exact = names.find((n) => n.toLowerCase() === input.toLowerCase());
  if (exact) return exact;
  const hits = names.filter((n) => n.toLowerCase().includes(input.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) die(`Ambiguous name "${input}". Matches: ${hits.join(', ')}`);
  die(`Unknown name "${input}". Known: ${names.join(', ')}`);
}

// Resolve a player by exact id or a case-insensitive name fragment, against the
// players people actually picked (those are the only ones a peanut can land on).
function resolvePlayer(input) {
  const players = [];
  for (const p of (readJSON(PICKS).people || [])) {
    for (const pl of (p.players || [])) players.push({ id: String(pl.id), name: pl.name });
  }
  const byId = players.find((pl) => pl.id === String(input));
  if (byId) return byId;
  const seen = new Map();
  for (const pl of players) {
    if (pl.name.toLowerCase().includes(input.toLowerCase())) seen.set(pl.id, pl);
  }
  const hits = Array.from(seen.values());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) die(`Ambiguous player "${input}". Matches: ${hits.map((h) => `${h.name} (${h.id})`).join(', ')}`);
  die(`No picked player matches "${input}".`);
}

function loadManual() {
  const m = readJSON(MANUAL);
  m.missedPenalties = m.missedPenalties || {};
  m.done = m.done || {};
  m.adjust = m.adjust || {};
  return m;
}

function saveManual(m) {
  const out = JSON.stringify(m, null, 2) + '\n';
  fs.writeFileSync(MANUAL, out);
  fs.writeFileSync(MANUAL_PUBLIC, out);
}

function mergePeople() {
  const alloc = readJSON(ALLOCATIONS).people || [];
  const picks = readJSON(PICKS).people || [];
  const map = new Map();
  for (const p of alloc) map.set(p.name, { name: p.name, teams: p.teams || [], players: [] });
  for (const p of picks) {
    if (!map.has(p.name)) map.set(p.name, { name: p.name, teams: [], players: [] });
    map.get(p.name).players = p.players || [];
  }
  return Array.from(map.values());
}

function printBoard() {
  const manual = loadManual();
  const idx = buildIndex(readJSON(MATCHES));
  const pots = readJSON(POTS);
  const potA = new Set((pots.potA || []).map((t) => t.id));
  const potB = new Set((pots.potB || []).map((t) => t.id));
  const rows = mergePeople().map((person) => ({
    name: person.name,
    pn: computePeanutsFor(person, idx, potA, potB, manual)
  }));
  rows.sort((a, b) => b.pn.outstanding - a.pn.outstanding || a.name.localeCompare(b.name));
  const SRC = [['entry', 'entry'], ['red', 'red'], ['shock', 'shock'], ['boredom', 'bore'], ['missedPen', 'miss']];
  console.log('Outstanding peanuts:');
  for (const { name, pn } of rows) {
    const bits = SRC.filter(([k]) => pn.src[k]).map(([k, l]) => `${l} ${pn.src[k]}`);
    if (pn.adjust) bits.push(`adj ${pn.adjust > 0 ? '+' : ''}${pn.adjust}`);
    if (pn.done) bits.push(`done ${pn.done}`);
    const badge = pn.outstanding > 0 ? `🥜x${pn.outstanding}` : '  · ';
    console.log(`  ${badge}  ${name.padEnd(10)} (${bits.join(', ') || 'nothing'})`);
  }
}

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'list') return printBoard();

  const m = loadManual();
  if (cmd === 'done' || cmd === 'undo') {
    const name = resolveName(a || die('usage: done|undo <Name>'));
    const cur = Number(m.done[name]) || 0;
    const next = Math.max(0, cur + (cmd === 'done' ? 1 : -1));
    if (next === 0) delete m.done[name]; else m.done[name] = next;
    console.log(`${name}: done ${cur} -> ${next}`);
  } else if (cmd === 'miss' || cmd === 'unmiss') {
    const pl = resolvePlayer(a || die('usage: miss|unmiss <PlayerOrId>'));
    const cur = Number(m.missedPenalties[pl.id]) || 0;
    const next = Math.max(0, cur + (cmd === 'miss' ? 1 : -1));
    if (next === 0) delete m.missedPenalties[pl.id]; else m.missedPenalties[pl.id] = next;
    console.log(`${pl.name} (${pl.id}): missed pens ${cur} -> ${next}`);
  } else if (cmd === 'adjust') {
    const name = resolveName(a || die('usage: adjust <Name> <+/-n>'));
    const delta = Number(b);
    if (!Number.isInteger(delta)) die(`adjust amount must be a whole number, got: ${b}`);
    const cur = Number(m.adjust[name]) || 0;
    const next = cur + delta;
    if (next === 0) delete m.adjust[name]; else m.adjust[name] = next;
    console.log(`${name}: adjust ${cur} -> ${next}`);
  } else {
    die(`Unknown command "${cmd}". Use: done | undo | miss | unmiss | adjust | list`);
  }

  saveManual(m);
}

main();
