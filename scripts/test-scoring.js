#!/usr/bin/env node
/*
 * Sanity test for the leaderboard math. Runs the same pure functions the
 * browser uses (from public/app.js) against a hand-checked sample dataset.
 *
 *   node scripts/test-scoring.js
 */

'use strict';

const assert = require('assert');
const { computeStandings, buildIndex } = require('../public/app.js');

const scoring = {
  team: { win: 3, draw: 1, loss: 0, cleanSheet: 1 },
  teamProgression: { R16: 4, QF: 7, SF: 11, Final: 16, Champions: 25 },
  player: { goal: 4, assist: 2, motm: 3, cleanSheet: 2, yellow: -1, red: -3, ownGoal: -2 },
  payout: { first: 0.6, second: 0.3, third: 0.1 }
};

// Team 10 beats Team 20 (2-0) in a group game, then reaches the R16.
// Player 100 (F, team 10): 1 goal, 1 assist, MOTM, 1 yellow.
// Player 200 (D, team 20): played, conceded 2 -> no clean sheet, 1 red.
const matches = {
  fixtures: [
    {
      id: 1, date: '2026-06-12T00:00:00Z', round: 'Group Stage - 1',
      status: 'FT', finished: true,
      homeTeam: { id: 10, name: 'Alpha', goals: 2 },
      awayTeam: { id: 20, name: 'Beta', goals: 0 },
      winnerTeamId: 10,
      players: [
        { id: 100, teamId: 10, name: 'Striker A', position: 'F', minutes: 90, goals: 1, assists: 1, yellow: 1, red: 0, ownGoals: 0 },
        { id: 200, teamId: 20, name: 'Defender B', position: 'D', minutes: 90, goals: 0, assists: 0, yellow: 0, red: 1, ownGoals: 0 }
      ]
    },
    {
      id: 2, date: '2026-06-30T00:00:00Z', round: 'Round of 16',
      status: 'NS', finished: false,
      homeTeam: { id: 10, name: 'Alpha', goals: null },
      awayTeam: { id: 30, name: 'Gamma', goals: null },
      winnerTeamId: null,
      players: []
    }
  ]
};

const allocations = {
  people: [
    { name: 'P1', teams: [{ id: 10 }, { id: 20 }] },
    { name: 'P2', teams: [{ id: 30 }] }
  ]
};
const picks = {
  people: [
    { name: 'P1', players: [{ id: 100 }, { id: 200 }] }
  ]
};
const motm = { motm: { '1': 100 } };

const idx = buildIndex(matches);
const standings = computeStandings({ scoring, allocations, picks, motm, idx });
const p1 = standings.find((s) => s.name === 'P1');

// Team 10: win (+3) + clean sheet (+1) + reach R16 (+4) = 8
// Team 20: loss (0) + no clean sheet = 0
assert.strictEqual(p1.teams.find((t) => t.id === 10).points, 8, 'team 10 points');
assert.strictEqual(p1.teams.find((t) => t.id === 20).points, 0, 'team 20 points');
assert.strictEqual(p1.teamPts, 8, 'P1 team total');

// Player 100: goal +4, assist +2, MOTM +3, yellow -1 = 8
// Player 200: red -3 (defender but conceded 2 -> no clean sheet) = -3
assert.strictEqual(p1.players.find((p) => p.id === 100).points, 8, 'player 100 points');
assert.strictEqual(p1.players.find((p) => p.id === 200).points, -3, 'player 200 points');
assert.strictEqual(p1.playerPts, 5, 'P1 player total');

assert.strictEqual(p1.total, 13, 'P1 grand total');
assert.strictEqual(p1.playerGoals, 1, 'P1 combined player goals');
assert.strictEqual(p1.furthestRank, 1, 'P1 furthest stage rank = R16 (index 1)');

console.log('All scoring assertions passed. P1 total =', p1.total);
