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
  entrants.json      the roster: name + id + paid (paid-only gate)
  pots.json          Pot A (stronger 24) + Pot B (outsiders 24) team IDs
  allocations.json   each person → their 2 team IDs (written by the draw)
  picks.json         each person → their 2 player IDs
  scoring.json       all point values + payout split
  motm.json          { fixtureId: playerId } Man of the Match map
scripts/
  draw.js            deterministic, seeded draw → writes allocations.json
  fetch.js           the data job (run by the Action)
  verify-picks.js    one-off pick-position validator
  test-scoring.js    sanity test for the leaderboard math (needs Node)
  serve.py           tiny local static server for previewing
public/            ← served by GitHub Pages
  index.html, styles.css, app.js
  config/            mirror of /config, written by the Action (browser reads this)
  data/              matches.json + last-updated.txt, written by the Action
.github/workflows/
  fetch.yml          cron data job (commits to main)
  pages.yml          deploys ./public to GitHub Pages on each push to main
scripts/deploy.sh    one-command repo create + push + enable Pages (needs gh auth)
```

> **Why `public/config` exists:** Pages serves `/public`, but you edit `config/` at the repo
> root. The fetch job mirrors the config files into `public/config/` each run so the
> browser can read them same-origin. Edit the root `config/` files; changes go live on the
> next Action run (≤30 min).

> **Paid-only:** only people with `"paid": true` in `config/entrants.json` are included —
> both in the draw and on the live leaderboard. Unpaid people never appear in either. The
> rules panel shows the live paid-entrant count and the prize split.

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
| **Team progression** (once each) | R16 +4, QF +7, SF +11, Final +16, Champions +25 |
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
