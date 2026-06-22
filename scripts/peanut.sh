#!/usr/bin/env bash
#
# Maintain the manual side of the AUTO peanut engine, mirror to public/, commit
# and push. The board now EARNS peanuts on its own from match data (entry, red
# card, shock, boredom); this script only edits the bits the feed can't give us:
# who's physically done their peanut, manual missed penalties, and any fudge.
#
# Usage:
#   scripts/peanut.sh done  <Name>          # someone had their tequila  (done +1)
#   scripts/peanut.sh undo  <Name>          # took it back                (done -1)
#   scripts/peanut.sh miss  <PlayerOrId>    # a picked player missed a pen (+1 each owner)
#   scripts/peanut.sh unmiss <PlayerOrId>   # undo a missed penalty
#   scripts/peanut.sh adjust <Name> <+/-n>  # manual tweak for anything else
#   scripts/peanut.sh list                  # show the current outstanding board
#
# Examples:
#   scripts/peanut.sh done Ogi              # Ogi has done a peanut
#   scripts/peanut.sh miss Messi            # Messi missed a penalty
#   scripts/peanut.sh adjust Yates +1       # Yates owes one for something off-pitch
#
# Everything (edit + mirror + commit + push) happens in here, so the whole
# workflow is a single approvable command. Retries the push to ride out the
# scheduled data-bot pushing to main at the same time.
#
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

CMD="${1:?usage: scripts/peanut.sh <done|undo|miss|unmiss|adjust|list> ...}"

# `list` just prints the computed board and exits — no write, no push.
if [ "$CMD" = "list" ]; then
  node scripts/peanut-engine.js list
  exit 0
fi

shift
node scripts/peanut-engine.js "$CMD" "$@"

# Nothing changed? Then there's nothing to publish.
if git diff --quiet -- config/peanuts-manual.json public/config/peanuts-manual.json; then
  echo "No change — nothing to push."
  exit 0
fi

git add config/peanuts-manual.json public/config/peanuts-manual.json
git commit -m "data: peanut update (${CMD} $*)"

# The scheduled fetch bot also pushes to main, so a single push can lose the
# race. Rebase + retry a few times before giving up.
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
