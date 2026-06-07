# World Cup 2026 Sweeps

A self-running leaderboard for a 20-person sweepstake over the 2026 FIFA World Cup
(48 teams, 11 Jun – 19 Jul 2026). Each person is drawn 2 teams and picks 2 players;
points accrue automatically from live match data. One shared URL, no login.

## How it works

Match data comes from **ESPN's public soccer JSON API** — free, no key, no signup. The
browser never calls it directly; a server-side job does. Instead:

1. A **GitHub Action** runs on a cron (every ~30 min). It reads ESPN's free API
   (`site.api.espn.com`), builds a compact `public/data/matches.json` (fixtures + statuses +
   per-player goals/assists/cards/line-ups), and commits it. No API key or secret is needed.
2. The **static front-end** (GitHub Pages, served from `/public`) reads the committed JSON
   and computes the leaderboard in the browser. All point values come from `scoring.json`,
   so the rules can be tuned by editing one file with no code changes.

> **Why ESPN, not API-Football?** API-Football's free tier does not cover season 2026
> (it stops at 2024), and its browser-readable data needs a paid plan. ESPN's endpoints are
> free and return everything the scoring needs — including goal *assisters*, which many free
> feeds omit. IDs below are therefore **ESPN** team/player ids.

```
config/            ← you edit these by hand (source of truth)
  entrants.json      the roster: name + id + paid (+ optional amount/datePaid, NEVER published)
  pots.json          Pot A (stronger 24) + Pot B (outsiders 24) team IDs
  allocations.json   each person → their 2 team IDs (draw, or synced from Sheet)
  picks.json         each person → their 2 player IDs (synced from Sheet)
  scoring.json       all point values + payout split
  motm.json          { fixtureId: playerId } Man of the Match map
  preseason.json     pre-season banner: buy-in, pay-by deadline, cheeky copy (no personal data)
  backend.json       Apps Script web-app URL for the self-serve draw (no secret)
backend/
  Code.gs            Google Apps Script web app (paste into the bound Sheet)
scripts/
  draw.js            deterministic, seeded draw → allocations.json + private/ files
  fetch.js           the data job (run by the Action)
  fetch-squads.js    builds public/data/players.json from ESPN squads
  build-roster.js    writes public/data/roster.json — SAFE name+paid subset for the tracker
  sync-sheet.js      pulls token-free Sheet export → allocations.json + picks.json
  verify-picks.js    one-off pick-position validator
  test-scoring.js    sanity test for the leaderboard math (needs Node)
  serve.py           tiny local static server for previewing
private/           ← gitignored; written by draw.js, NEVER committed
  entrants-sheet.tsv rows to paste into the Sheet (includes tokens)
  links.txt          one personal reveal link per person, to DM
public/            ← served by GitHub Pages
  index.html, styles.css, app.js   the live leaderboard
  draw.html, draw.js               the self-serve reveal + picks page
  config/            mirror of /config, written by the Action (browser reads this)
  data/              matches.json + players.json + roster.json + last-updated.txt
.github/workflows/
  fetch.yml          cron data job: squads + sheet sync + match data (commits to main)
  pages.yml          deploys ./public to GitHub Pages on each push to main
scripts/deploy.sh    one-command repo create + push + enable Pages (needs gh auth)
```

> **Why `public/config` exists:** Pages serves `/public`, but you edit `config/` at the repo
> root. The fetch job mirrors the config files into `public/config/` each run so the
> browser can read them same-origin. Edit the root `config/` files; changes go live on the
> next Action run (≤30 min).

> **Paid-only:** only people with `"paid": true` in `config/entrants.json` are included in the
> draw and counted in the leaderboard's paid total. The rules panel shows the live paid-entrant
> count and the prize split.
>
> **Privacy:** `config/entrants.json` is the admin source of truth and may hold `amount` /
> `datePaid` — it is **never** mirrored to `public/`. The browser reads only the safe
> `public/data/roster.json` (name + paid), written by `scripts/build-roster.js`. Tokens, teams
> and picks never reach the roster file.

## Pre-season mode (before kickoff)

Before any fixture is live or finished, the same page (same URL) shows a **sign-up tracker**
instead of an empty points board: the buy-in, the pay-by countdown, a paid/total progress bar,
and everyone's name with a **Paid / Not yet** badge (paid first). The moment a fixture goes
live or finishes, it **auto-switches** to the full points leaderboard — no redeploy, no URL
change. The switch is data-driven (`app.js` checks whether any fixture is live/finished), so
nothing to flip by hand.

Edit the banner copy, buy-in and deadline in `config/preseason.json`. The roster shown is
`public/data/roster.json` (name + paid only), rebuilt from `config/entrants.json` on every
Action run — add names there and flip `paid` to `true` as people pay.

## Setup

No API key or account is required — ESPN's data is free.

1. **New GitHub repo + push + enable Pages.** Run `scripts/deploy.sh <repo-name> --public`
   (needs `gh auth login` first). It creates the repo, pushes, and sets Pages **Source =
   "GitHub Actions"**. (Branch-based Pages only serves the repo root or `/docs`, *not*
   `/public`, so this project ships a Pages deploy workflow — `.github/workflows/pages.yml`.)
   Note the Pages URL it prints.
2. **Run the first data fetch.** Trigger it from the **Actions** tab ("Fetch World Cup
   data" → Run workflow); it commits `public/data/matches.json` with the full schedule.
3. **Fill the roster.** List everyone in `config/entrants.json` with `"paid": true|false`.
   Check the pots in `config/pots.json` (a starter 24/24 split is provided from the real
   ESPN team IDs in `matches.json` — review it and move teams between Pot A / Pot B to match
   your seeding).
4. **Run the draw** (see below). It reads the paid entrants + pots and writes
   `config/allocations.json`.
5. **Fill `config/picks.json`** — each person's two player IDs: index 0 = forward/attacker
   (Pot A pick), index 1 = midfielder/defender/goalkeeper (Pot B pick). Names must match
   `entrants.json` / `allocations.json`. Player IDs appear in `matches.json` once a player
   features, or come from ESPN squad pages.
6. **Commit, push, and share the Pages URL** with the group.

## The draw

The draw is **deterministic from a seed** — a seeded PRNG (cyrb128 → sfc32), never
`Math.random()` — so the same seed and the same entrants/pots always produce a byte-identical
`config/allocations.json`. Run it from the repo root (needs Node 18+):

```
node scripts/draw.js --seed 04-11-23-31-44-09
```

It includes **only paid entrants** (`config/entrants.json`), assigns each one exactly one
Pot A and one Pot B team with no team used twice, writes `config/allocations.json`, and prints
a readable summary. It works for any paid count up to the pot size (≤ 24 per pot).

**Anyone can verify the draw.** Agree a public seed in advance — e.g. a specific **National
Lottery** draw, entered as the seed string. After the draw, anyone with the repo can re-run
`node scripts/draw.js --seed <that-seed>` and `git diff config/allocations.json`: an identical
file proves the allocation was not hand-picked. (Run the draw *after* the agreed numbers are
public so nobody can pre-compute a favourable seed.)

## Self-serve draw & picks (optional, gamified)

Instead of you collecting everyone's player picks by hand, each paid person opens their **own
personal link**, watches two wheels *reveal* their pre-drawn teams, then picks their two
players themselves. Zero manual data entry — the picks flow straight back into the static
leaderboard JSON. It layers on top of the deterministic draw above; the wheels never roll the
draw live, they only *reveal* the sealed result (a refresh always lands on the same teams).

**How the integrity holds up:** the seeded `draw.js` is still the source of truth for teams.
The repo is public, so per-person **tokens never touch it** — they live only in a private
Google Sheet + Apps Script web app (free). The static page holds no tokens; it just asks the
backend "what's the draw for *this* token?".

```
draw.js ──► private/entrants-sheet.tsv ──► paste into private Google Sheet
        └─► private/links.txt (one URL per person, you DM these)

person opens draw.html?t=<token>
        └─► Apps Script getDraw  → sealed teams → wheels reveal them
        └─► picks 2 players      → Apps Script submitPicks (one-shot lock)

GitHub Action ──► Apps Script export (token-free) ──► config/allocations.json + picks.json
              └─► fetch-squads.js ──► public/data/players.json (pick dropdowns)
```

### One-time backend setup (free Google account; ~5 min)

You must do these account-bound steps yourself — they can't be scripted:

1. **Squads first.** Run the data workflow once with **force_squads** ticked (Actions →
   "Fetch World Cup data" → Run workflow). It commits `public/data/players.json`, which powers
   the pick dropdowns and the backend's position check. (Squads populate close to the
   tournament; re-run if a list is empty.)
2. **Create a Google Sheet.** Add a tab named exactly **`Entrants`** with this header in row 1:
   `name | id | token | teamA_id | teamB_id | submitted | pickFwd_id | pickOther_id`.
3. **Run the draw with a base URL** so the links are ready to send:
   `node scripts/draw.js --seed <seed> --base-url https://<user>.github.io/<repo>`.
   It writes `private/entrants-sheet.tsv` (paste its rows under the header) and
   `private/links.txt` (one personal link per person). The `private/` folder is gitignored —
   never commit it.
4. **Add the web app.** In the Sheet: Extensions → Apps Script, paste `backend/Code.gs`, set
   `PLAYERS_JSON_URL` to your `…/data/players.json` URL, then Deploy → New deployment → Web
   app, **Execute as: Me**, **Who has access: Anyone**. Copy the `/exec` URL.
5. **Wire it up.** Paste that `/exec` URL into `config/backend.json` (`apiUrl`), commit, push.
   The page goes live and the Action's sync step starts mirroring submitted picks into
   `config/picks.json` automatically.
6. **DM the links** from `private/links.txt`. Each person reveals their teams and picks once;
   re-visiting shows their locked summary.

> **Why the backend, not just the published Sheet?** Publishing the Sheet to the web would
> expose the token column. Instead the Action calls a dedicated `export` endpoint that returns
> rows **without** tokens, so nothing secret is ever committed to the public repo.

## During the tournament

- **Man of the Match:** the API has none, so after each finished match add one line to
  `config/motm.json` — `"<fixtureId>": <playerId>` (find the fixtureId in
  `public/data/matches.json`). Editable on github.com, even from a phone.
- **Tweaking scoring:** edit `config/scoring.json`. The rules panel and all totals update on
  the next Action run.
- **Picks are locked** before the opening match and never change — no transfers, no swaps.

## Scoring

| | |
|---|---|
| **Team / match** | win +3, draw +1, loss 0, clean sheet +1 |
| **Team progression** (once each) | R16 +1, QF +2, SF +3, Final +4, Champions +5 |
| **Player / match** | goal +4, assist +2, MOTM +3, clean sheet +2 (DEF/GK only), yellow −1, red −3, own goal −2 |

A person's total = both teams + both players. **Tiebreakers:** total points → combined goals
by the person's 2 players → furthest-progressing team → coin flip.

**Payout:** pot split **60% / 30% / 10%** to 1st / 2nd / 3rd.

## Rate limits

The job pulls the fixture list once per run, then fetches event detail only for fixtures that
are live or have finished since the last run; settled games are kept from the previous file.
A busy 4-match day stays well under ~100 requests. If a fetch fails, the last good
`matches.json` keeps serving (the page never goes blank). If it ever gets tight, API-Football
has a cheap one-month paid tier as a safety valve.

## Local preview

No Node required for the front-end. From the repo root:

```
python3 scripts/serve.py     # serves public/ at http://127.0.0.1:4173
```

To run the scoring sanity test (needs Node 18+): `node scripts/test-scoring.js`.
