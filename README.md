# World Cup 2026 Sweeps

A self-running leaderboard for a 20-person sweepstake over the 2026 FIFA World Cup
(48 teams, 11 Jun – 19 Jul 2026). Each person is drawn 2 teams and picks 2 players;
points accrue automatically from live match data. One shared URL, no login.

## How it works

The free API tier is ~100 requests/day and the key must never live in client code, so
**the browser never calls the API**. Instead:

1. A **GitHub Action** runs on a cron (every ~30 min). It calls API-Football, builds a
   compact `public/data/matches.json` (fixtures + statuses + per-player events), and commits
   it. The API key is a GitHub Actions **secret** — never in the repo.
2. The **static front-end** (GitHub Pages, served from `/public`) reads the committed JSON
   and computes the leaderboard in the browser. All point values come from `scoring.json`,
   so the rules can be tuned by editing one file with no code changes.

```
config/            ← you edit these by hand (source of truth)
  allocations.json   each person → their 2 team IDs
  picks.json         each person → their 2 player IDs
  scoring.json       all point values + payout split
  motm.json          { fixtureId: playerId } Man of the Match map
scripts/
  fetch.js           the data job (run by the Action)
  verify-picks.js    one-off pick-position validator
  test-scoring.js    sanity test for the leaderboard math (needs Node)
  serve.py           tiny local static server for previewing
public/            ← served by GitHub Pages
  index.html, styles.css, app.js
  config/            mirror of /config, written by the Action (browser reads this)
  data/              matches.json + last-updated.txt, written by the Action
.github/workflows/fetch.yml
```

> **Why `public/config` exists:** Pages serves `/public`, but you edit `config/` at the repo
> root. The fetch job mirrors the four config files into `public/config/` each run so the
> browser can read them same-origin. Edit the root `config/` files; changes go live on the
> next Action run (≤30 min).

## Setup

1. **Get an API key.** Create a free account at <https://www.api-football.com> (API-Sports).
   Confirm the current free-tier daily request limit on your dashboard. World Cup =
   `league=1`, `season=2026`.
2. **New GitHub repo.** Push this folder to it. Under **Settings → Secrets and variables →
   Actions**, add a secret named `API_FOOTBALL_KEY` with your key.
3. **Enable GitHub Pages.** Settings → Pages → deploy from branch, root `/public`
   (or publish `/public` to a `gh-pages` branch). Note the Pages URL.
4. **Run the draw offline**, then fill in:
   - `config/allocations.json` — each person's name + their two team IDs (1 from Pot A,
     1 from Pot B). Find team IDs from `public/data/matches.json` after the first Action run,
     or via `GET /teams?league=1&season=2026`.
   - `config/picks.json` — each person's two player IDs: index 0 = forward/attacker (Pot A),
     index 1 = midfielder/defender/goalkeeper (Pot B). Names must match `allocations.json`.
   - Optionally run the validator: `API_FOOTBALL_KEY=xxx node scripts/verify-picks.js`
     (checks each pick's position; exits non-zero on any problem).
5. **Confirm the Action runs.** Trigger it manually from the **Actions** tab
   ("Fetch World Cup data" → Run workflow), check it commits `public/data/matches.json`,
   then share the Pages URL with the group.

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
