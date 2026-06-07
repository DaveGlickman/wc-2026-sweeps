/*
 * World Cup 2026 Sweeps — self-serve draw + picks page.
 *
 * Reads ?t=<token>, asks the Apps Script backend for THIS person's sealed teams
 * (never rolled in the browser — a refresh always lands on the same teams),
 * reveals them on two spinning wheels, then lets them pick two players and
 * submit once. After submission (or on a return visit) it shows a locked
 * summary instead of the wheels.
 *
 * No tokens are ever stored in the repo — the backend URL in config/backend.json
 * is the only thing the page needs, and security is per-token on the backend.
 */

'use strict';

const CONFIG = './config';
const DATA = './data';
const SPIN_MS = 4200;

function $(sel) { return document.querySelector(sel); }
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function tokenFromUrl() {
  const p = new URLSearchParams(location.search);
  return (p.get('t') || p.get('token') || '').trim();
}

function fail(msg) {
  const s = $('#status');
  s.className = 'status error';
  s.textContent = msg;
  show(s);
}

function info(msg) {
  const s = $('#status');
  s.className = 'status';
  s.textContent = msg;
  show(s);
}

// ---- wheel ----------------------------------------------------------------

// FIFA 3-letter code + a representative flag colour per nation, keyed by a
// normalised name (lowercased, accents/punctuation stripped). Slices use the
// colour and show the code; the result card still reveals the full name.
const COUNTRY = {
  argentina: ['ARG', '#6CACE4'], spain: ['ESP', '#AA151B'], france: ['FRA', '#0055A4'],
  england: ['ENG', '#CE1124'], brazil: ['BRA', '#FEDF00'], portugal: ['POR', '#046A38'],
  netherlands: ['NED', '#F36C21'], belgium: ['BEL', '#FDDA24'], germany: ['GER', '#DD0000'],
  croatia: ['CRO', '#C1121C'], morocco: ['MAR', '#C1272D'], colombia: ['COL', '#FCD116'],
  uruguay: ['URU', '#5AAAE0'], unitedstates: ['USA', '#3C3B6E'], mexico: ['MEX', '#006847'],
  switzerland: ['SUI', '#D52B1E'], japan: ['JPN', '#BC002D'], senegal: ['SEN', '#00853F'],
  iran: ['IRN', '#239F40'], southkorea: ['KOR', '#0047A0'], ecuador: ['ECU', '#FFDD00'],
  australia: ['AUS', '#FFB81C'], austria: ['AUT', '#ED2939'], turkiye: ['TUR', '#E30A17'],
  norway: ['NOR', '#BA0C2F'], sweden: ['SWE', '#006AA7'], scotland: ['SCO', '#005EB8'],
  czechia: ['CZE', '#11457E'], egypt: ['EGY', '#CE1126'], ivorycoast: ['CIV', '#F77F00'],
  ghana: ['GHA', '#006B3F'], algeria: ['ALG', '#006233'], tunisia: ['TUN', '#E70013'],
  southafrica: ['RSA', '#007A4D'], canada: ['CAN', '#D80621'], paraguay: ['PAR', '#D52B1E'],
  panama: ['PAN', '#005293'], qatar: ['QAT', '#8A1538'], saudiarabia: ['KSA', '#006C35'],
  uzbekistan: ['UZB', '#0099B5'], bosniaherzegovina: ['BIH', '#002F6C'], capeverde: ['CPV', '#003893'],
  congodr: ['COD', '#007FFF'], curacao: ['CUW', '#002B7F'], haiti: ['HAI', '#00209F'],
  iraq: ['IRQ', '#CE1126'], jordan: ['JOR', '#007A3D'], newzealand: ['NZL', '#00247D']
};

const SPOKE = 'rgba(8, 12, 28, 0.55)';
const DEFAULT_COLOR = '#6c8cff';

function normalizeName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}

// Code + colour for a team name, with a sensible fallback for unmapped nations.
function countryInfo(name) {
  const hit = COUNTRY[normalizeName(name)];
  if (hit) return { code: hit[0], color: hit[1] };
  const letters = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z]/g, '');
  return { code: letters.slice(0, 3) || '???', color: DEFAULT_COLOR };
}

// Black or white text, whichever is more legible on the slice colour.
function textOn(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0b1020' : '#ffffff';
}

function buildWheel(el, pot) {
  const n = pot.length;
  const slice = 360 / n;
  // Thin dark spoke between slices so adjacent same-coloured nations stay distinct.
  const gap = n > 1 ? Math.min(0.9, slice * 0.08) : 0;

  const stops = [];
  for (let i = 0; i < n; i++) {
    const { color } = countryInfo(pot[i].name);
    const start = i * slice;
    const end = (i + 1) * slice;
    stops.push(`${color} ${start}deg ${end - gap}deg`);
    if (gap) stops.push(`${SPOKE} ${end - gap}deg ${end}deg`);
  }
  el.style.background = `conic-gradient(${stops.join(',')})`;

  // Radial labels: the FIFA code, coloured for contrast against its slice.
  el.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const { code, color } = countryInfo(pot[i].name);
    const label = document.createElement('span');
    label.className = 'wheel-label';
    const span = document.createElement('span');
    span.textContent = code;
    const onColor = textOn(color);
    span.style.color = onColor;
    if (onColor === '#ffffff') span.style.textShadow = '0 1px 2px rgba(0,0,0,0.45)';
    label.appendChild(span);
    // Pie-label: bar pinned at the hub, rotated to the slice centre; text sits
    // near the rim. translateX(-50%) keeps it horizontally centred on the hub.
    label.style.transform = `translateX(-50%) rotate(${i * slice + slice / 2}deg)`;
    el.appendChild(label);
  }
}

// Spin so the slice for targetId stops under the top pointer.
function spinWheel(el, pot, targetId) {
  return new Promise((resolve) => {
    const n = pot.length;
    const slice = 360 / n;
    let index = pot.findIndex((t) => String(t.id) === String(targetId));
    if (index < 0) index = 0;
    const center = index * slice + slice / 2;
    const turns = 5;
    const finalDeg = 360 * turns - center;

    if (prefersReducedMotion()) {
      el.style.transition = 'none';
      el.style.transform = `rotate(${-center}deg)`;
      resolve();
      return;
    }
    el.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    // Force a reflow so the transition applies from the current angle.
    void el.offsetWidth;
    el.style.transform = `rotate(${finalDeg}deg)`;
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, SPIN_MS + 300);
  });
}

function teamLabel(pot, id) {
  const t = pot.find((x) => String(x.id) === String(id));
  return (t && t.name) || `Team ${id}`;
}

// ---- searchable combobox --------------------------------------------------

function setupCombo(opts) {
  const { input, list, chosenBox, players, onChange } = opts;
  let selected = null;

  function render(query) {
    const q = query.trim().toLowerCase();
    list.innerHTML = '';
    const matches = players
      .filter((p) => !q || (p.name || '').toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q))
      .slice(0, 60);
    if (!matches.length) {
      const li = document.createElement('li');
      li.className = 'combo-empty';
      li.textContent = 'No matches';
      list.appendChild(li);
    } else {
      for (const p of matches) {
        const li = document.createElement('li');
        li.className = 'combo-option';
        li.setAttribute('role', 'option');
        li.innerHTML = `<span class="opt-name"></span><span class="opt-team"></span>`;
        li.querySelector('.opt-name').textContent = p.name || `Player ${p.id}`;
        li.querySelector('.opt-team').textContent = p.team || '';
        li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(p); });
        list.appendChild(li);
      }
    }
    show(list);
    input.setAttribute('aria-expanded', 'true');
  }

  function pick(p) {
    selected = p;
    hide(list);
    input.setAttribute('aria-expanded', 'false');
    input.value = '';
    hide(input);
    chosenBox.innerHTML =
      `<span class="chosen-name"></span><span class="chosen-team"></span><button type="button" class="chosen-change">change</button>`;
    chosenBox.querySelector('.chosen-name').textContent = p.name || `Player ${p.id}`;
    chosenBox.querySelector('.chosen-team').textContent = p.team || '';
    chosenBox.querySelector('.chosen-change').addEventListener('click', clear);
    show(chosenBox);
    onChange(selected);
  }

  function clear() {
    selected = null;
    hide(chosenBox);
    show(input);
    input.value = '';
    input.focus();
    onChange(selected);
  }

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('blur', () => setTimeout(() => hide(list), 150));

  return { get: () => selected };
}

// ---- locked summary -------------------------------------------------------

function renderLocked(state) {
  const { name, teams, players } = state;
  $('#lockedGreeting').textContent = `${name}, you’re locked in.`;

  const tWrap = $('#lockedTeams');
  tWrap.innerHTML = '';
  teams.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'locked-item';
    card.innerHTML = `<span class="li-tag"></span><span class="li-name"></span>`;
    card.querySelector('.li-tag').textContent = i === 0 ? 'Pot A' : 'Pot B';
    card.querySelector('.li-name').textContent = t;
    tWrap.appendChild(card);
  });

  const pWrap = $('#lockedPlayers');
  pWrap.innerHTML = '';
  players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'locked-item';
    card.innerHTML = `<span class="li-tag"></span><span class="li-name"></span>`;
    card.querySelector('.li-tag').textContent = i === 0 ? 'Attacker' : 'Mid/Def/GK';
    card.querySelector('.li-name').textContent = p;
    pWrap.appendChild(card);
  });

  hide($('#status'));
  hide($('#reveal-section'));
  hide($('#picks-section'));
  show($('#locked-section'));
}

function playerName(playersById, id) {
  const p = playersById.get(String(id));
  return p ? `${p.name}${p.team ? ' · ' + p.team : ''}` : `Player ${id}`;
}

// ---- main -----------------------------------------------------------------

async function main() {
  const token = tokenFromUrl();
  if (!token) {
    fail('This page needs your personal link. Ask the organiser for your draw link.');
    return;
  }

  let backend, pots, playersDoc;
  try {
    [backend, pots, playersDoc] = await Promise.all([
      getJSON(`${CONFIG}/backend.json`).catch(() => ({})),
      getJSON(`${CONFIG}/pots.json`).catch(() => ({ potA: [], potB: [] })),
      getJSON(`${DATA}/players.json`).catch(() => ({ players: [] }))
    ]);
  } catch (e) {
    fail(`Could not load the draw: ${e.message}`);
    return;
  }

  const apiUrl = (backend.apiUrl || '').trim();
  if (!apiUrl) {
    info('The draw isn’t open yet. Check back once the organiser has set it up.');
    return;
  }

  const potA = (pots.potA || []).map((t) => ({ id: String(t.id), name: t.name || null }));
  const potB = (pots.potB || []).map((t) => ({ id: String(t.id), name: t.name || null }));
  const allPlayers = (playersDoc.players || []).map((p) => ({ ...p, id: String(p.id) }));
  const playersById = new Map(allPlayers.map((p) => [p.id, p]));
  const attackers = allPlayers.filter((p) => p.position === 'Attacker');
  const others = allPlayers.filter((p) => p.position === 'Mid/Def/GK');

  // Sealed draw — fetched, never rolled here.
  let draw;
  try {
    draw = await getJSON(`${apiUrl}?action=getDraw&token=${encodeURIComponent(token)}`);
  } catch (e) {
    fail(`Could not reach the draw service: ${e.message}`);
    return;
  }
  if (!draw || draw.ok === false) {
    fail('Link not recognised. Double-check the link the organiser sent you.');
    return;
  }

  const teamAName = teamLabel(potA, draw.teamA_id);
  const teamBName = teamLabel(potB, draw.teamB_id);

  // Already submitted (or returning visitor): straight to the locked summary.
  if (draw.submitted) {
    renderLocked({
      name: draw.name,
      teams: [teamAName, teamBName],
      players: [playerName(playersById, draw.pickFwd_id), playerName(playersById, draw.pickOther_id)]
    });
    return;
  }

  // ---- reveal flow ----
  hide($('#status'));
  $('#greeting').textContent = `${draw.name}, here’s your draw.`;
  buildWheel($('#wheelA'), potA);
  buildWheel($('#wheelB'), potB);
  show($('#reveal-section'));

  const spinA = $('#spinA');
  const spinB = $('#spinB');
  let revealedA = false, revealedB = false;

  function maybeShowNext() {
    if (revealedA && revealedB) show($('#toPicks'));
  }

  spinA.addEventListener('click', async () => {
    spinA.disabled = true;
    spinA.textContent = 'Spinning…';
    await spinWheel($('#wheelA'), potA, draw.teamA_id);
    const r = $('#resultA');
    r.textContent = `🎉 ${teamAName}`;
    show(r);
    spinA.textContent = 'Pot A drawn';
    revealedA = true;
    spinB.disabled = false;
    maybeShowNext();
  });

  spinB.addEventListener('click', async () => {
    spinB.disabled = true;
    spinB.textContent = 'Spinning…';
    await spinWheel($('#wheelB'), potB, draw.teamB_id);
    const r = $('#resultB');
    r.textContent = `🎉 ${teamBName}`;
    show(r);
    spinB.textContent = 'Pot B drawn';
    revealedB = true;
    maybeShowNext();
  });

  $('#toPicks').addEventListener('click', () => {
    hide($('#reveal-section'));
    show($('#picks-section'));
  });

  // ---- picks flow ----
  const submitBtn = $('#submitBtn');
  const confirmChk = $('#confirmChk');
  const pickError = $('#pickError');

  const comboFwd = setupCombo({
    input: $('#searchFwd'), list: $('#listFwd'), chosenBox: $('#chosenFwd'),
    players: attackers, onChange: updateSubmit
  });
  const comboOther = setupCombo({
    input: $('#searchOther'), list: $('#listOther'), chosenBox: $('#chosenOther'),
    players: others, onChange: updateSubmit
  });

  function updateSubmit() {
    submitBtn.disabled = !(comboFwd.get() && comboOther.get() && confirmChk.checked);
  }
  confirmChk.addEventListener('change', updateSubmit);

  if (!attackers.length || !others.length) {
    pickError.textContent = 'Player list isn’t available yet — the organiser needs to publish squads. Try again later.';
    show(pickError);
  }

  submitBtn.addEventListener('click', async () => {
    const fwd = comboFwd.get();
    const other = comboOther.get();
    if (!fwd || !other) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    hide(pickError);
    try {
      const url = `${apiUrl}?action=submitPicks&token=${encodeURIComponent(token)}` +
        `&fwd=${encodeURIComponent(fwd.id)}&other=${encodeURIComponent(other.id)}`;
      const res = await getJSON(url);
      if (res.ok || res.error === 'already_submitted') {
        const fwdId = res.pickFwd_id || fwd.id;
        const otherId = res.pickOther_id || other.id;
        renderLocked({
          name: res.name || draw.name,
          teams: [teamAName, teamBName],
          players: [playerName(playersById, fwdId), playerName(playersById, otherId)]
        });
        return;
      }
      const msgs = {
        fwd_not_attacker: 'Your first pick must be an attacker.',
        other_not_mid_def_gk: 'Your second pick must be a midfielder, defender or goalkeeper.',
        missing_picks: 'Please choose both players.',
        unknown_token: 'Link not recognised — check your personal link.'
      };
      pickError.textContent = msgs[res.error] || `Couldn’t submit (${res.error || 'unknown error'}). Please try again.`;
      show(pickError);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm & submit picks';
    } catch (e) {
      pickError.textContent = `Couldn’t submit: ${e.message}. Please try again.`;
      show(pickError);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm & submit picks';
    }
  });
}

main();
