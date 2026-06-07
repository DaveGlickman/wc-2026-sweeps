/*
 * World Cup 2026 Sweeps — self-serve draw/picks backend (Google Apps Script).
 *
 * A free Apps Script web app bound to a Google Sheet. It is the ONLY place the
 * per-person tokens and the sealed team draw live — the public GitHub repo never
 * sees them. The static reveal page (public/draw.html) talks to this over three
 * GET endpoints; the GitHub Action talks to the `export` endpoint to mirror the
 * (token-free) picks back into the repo's static JSON.
 *
 * Sheet layout — a tab named exactly "Entrants" with this header row in row 1:
 *
 *   name | id | token | teamA_id | teamB_id | submitted | pickFwd_id | pickOther_id
 *
 * Paste the rows printed by `node scripts/draw.js` (the private/entrants-sheet.tsv
 * file) under that header. `submitted` starts FALSE; the two pick columns start
 * blank — submitPicks fills them in and flips submitted to TRUE (one-shot).
 *
 * Deploy:  Extensions -> Apps Script, paste this file, set PLAYERS_JSON_URL
 * below, then Deploy -> New deployment -> Web app, "Execute as: Me",
 * "Who has access: Anyone". Copy the /exec URL into config/backend.json.
 *
 * Endpoints (all GET, JSON out):
 *   ?action=getDraw&token=...                     -> sealed teams + lock state
 *   ?action=submitPicks&token=...&fwd=..&other=.. -> one-shot write of picks
 *   ?action=export                                -> token-free rows for the Action
 */

// Public players.json served by GitHub Pages. Used to validate that the
// forward pick is an Attacker and the other pick is Mid/Def/GK. Set this to
// your Pages URL, e.g. https://<user>.github.io/<repo>/data/players.json
var PLAYERS_JSON_URL = 'https://REPLACE_ME.github.io/wc-2026-sweeps/data/players.json';

var SHEET_NAME = 'Entrants';
var COLS = { name: 0, id: 1, token: 2, teamA: 3, teamB: 4, submitted: 5, fwd: 6, other: 7 };

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'getDraw') return json(getDraw_(e.parameter.token));
    if (action === 'submitPicks') return json(submitPicks_(e.parameter));
    if (action === 'export') return json(exportRows_());
    return json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json({ ok: false, error: 'server_error', message: String(err && err.message || err) });
  }
}

function sheet_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Sheet tab "' + SHEET_NAME + '" not found');
  return sh;
}

// Find the 1-based row index for a token, or -1. Tokens are unique.
function findRowByToken_(sh, token) {
  if (!token) return -1;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) { // skip header row 0
    if (String(values[r][COLS.token]) === String(token)) return r + 1;
  }
  return -1;
}

function rowObject_(sh, rowIndex) {
  var v = sh.getRange(rowIndex, 1, 1, 8).getValues()[0];
  return {
    name: String(v[COLS.name] || ''),
    id: String(v[COLS.id] || ''),
    teamA_id: String(v[COLS.teamA] || ''),
    teamB_id: String(v[COLS.teamB] || ''),
    submitted: v[COLS.submitted] === true || String(v[COLS.submitted]).toUpperCase() === 'TRUE',
    pickFwd_id: v[COLS.fwd] === '' || v[COLS.fwd] == null ? null : String(v[COLS.fwd]),
    pickOther_id: v[COLS.other] === '' || v[COLS.other] == null ? null : String(v[COLS.other])
  };
}

// ?action=getDraw — never leaks other people's rows; only the matched one.
function getDraw_(token) {
  var sh = sheet_();
  var row = findRowByToken_(sh, token);
  if (row < 0) return { ok: false, error: 'unknown_token' };
  var o = rowObject_(sh, row);
  return {
    ok: true,
    name: o.name,
    teamA_id: o.teamA_id,
    teamB_id: o.teamB_id,
    submitted: o.submitted,
    pickFwd_id: o.pickFwd_id,
    pickOther_id: o.pickOther_id
  };
}

// ?action=submitPicks — one-shot, locked under LockService against double submit.
function submitPicks_(p) {
  var token = p && p.token;
  var fwd = p && String(p.fwd || '');
  var other = p && String(p.other || '');
  if (!token) return { ok: false, error: 'missing_token' };
  if (!fwd || !other) return { ok: false, error: 'missing_picks' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    var row = findRowByToken_(sh, token);
    if (row < 0) return { ok: false, error: 'unknown_token' };

    var o = rowObject_(sh, row);
    if (o.submitted) {
      return { ok: false, error: 'already_submitted',
        name: o.name, teamA_id: o.teamA_id, teamB_id: o.teamB_id,
        pickFwd_id: o.pickFwd_id, pickOther_id: o.pickOther_id };
    }

    var pos = playerPositions_();
    if (pos[fwd] !== 'Attacker') return { ok: false, error: 'fwd_not_attacker' };
    if (pos[other] !== 'Mid/Def/GK') return { ok: false, error: 'other_not_mid_def_gk' };

    sh.getRange(row, COLS.fwd + 1).setValue(fwd);
    sh.getRange(row, COLS.other + 1).setValue(other);
    sh.getRange(row, COLS.submitted + 1).setValue(true);
    SpreadsheetApp.flush();

    return { ok: true, name: o.name, teamA_id: o.teamA_id, teamB_id: o.teamB_id,
      pickFwd_id: fwd, pickOther_id: other };
  } finally {
    lock.releaseLock();
  }
}

// ?action=export — token-free snapshot for the GitHub Action to commit.
function exportRows_() {
  var sh = sheet_();
  var values = sh.getDataRange().getValues();
  var people = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    if (!String(v[COLS.name] || '').trim()) continue;
    var submitted = v[COLS.submitted] === true || String(v[COLS.submitted]).toUpperCase() === 'TRUE';
    people.push({
      name: String(v[COLS.name]),
      id: String(v[COLS.id] || ''),
      teamA_id: String(v[COLS.teamA] || ''),
      teamB_id: String(v[COLS.teamB] || ''),
      submitted: submitted,
      pickFwd_id: v[COLS.fwd] === '' || v[COLS.fwd] == null ? null : String(v[COLS.fwd]),
      pickOther_id: v[COLS.other] === '' || v[COLS.other] == null ? null : String(v[COLS.other])
    });
  }
  return { ok: true, people: people };
}

// Map playerId -> 'Attacker' | 'Mid/Def/GK', cached 6h to avoid refetching.
function playerPositions_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('player_pos');
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch(PLAYERS_JSON_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('players.json HTTP ' + res.getResponseCode());
  var doc = JSON.parse(res.getContentText());
  var list = (doc && doc.players) || [];
  var map = {};
  for (var i = 0; i < list.length; i++) map[String(list[i].id)] = list[i].position;
  cache.put('player_pos', JSON.stringify(map), 21600);
  return map;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
