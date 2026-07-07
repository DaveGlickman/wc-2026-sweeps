#!/usr/bin/env bash
#
# Record a Man of the Match, mirror to public/, commit and push. ESPN has no
# MOTM, so we enter the official award by hand (read it off the FIFA app or the
# match's Wikipedia page). Only a picked player's MOTM changes the board (+3).
#
#   scripts/motm.sh set   "<TeamA>" "<TeamB>" "<PlayerNameOrId>"
#   scripts/motm.sh unset "<TeamA>" "<TeamB>"
#   scripts/motm.sh list
#
#   e.g.  scripts/motm.sh set "England" "Croatia" "Kane"
#         scripts/motm.sh set "Argentina" "Algeria" 45843
#
# One approvable command: edit + mirror + commit + push, with the same push
# retry loop as peanut.sh to ride out the scheduled data bot.
#
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

CMD="${1:?usage: scripts/motm.sh <set|unset|list> ...}"

if [ "$CMD" = "list" ]; then
  node scripts/motm-engine.js list
  exit 0
fi

node scripts/motm-engine.js "$@"

if git diff --quiet -- config/motm.json public/config/motm.json; then
  echo "No change — nothing to push."
  exit 0
fi

git add config/motm.json public/config/motm.json
git commit -m "data: MOTM update (${CMD} ${2:-} ${3:-})"

for i in 1 2 3 4 5; do
  if git pull --rebase origin main && git push; then
    echo "Pushed."
    exit 0
  fi
  echo "push race with data bot, retrying ($i/5)..."
  sleep 2
done

echo "Push failed after 5 attempts." >&2
exit 1
