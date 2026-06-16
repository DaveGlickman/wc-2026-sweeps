#!/usr/bin/env bash
#
# Update a person's peanut count, mirror to public/, commit, and push.
#
#   scripts/peanut.sh <Name> <Count>
#   e.g.  scripts/peanut.sh Ogi 0      # Ogi has had his peanut
#         scripts/peanut.sh Yates 2    # Yates now owes two
#
# Everything (edit + mirror + commit + push) happens in here, so the whole
# peanut workflow is a single approvable command. Retries the push to ride out
# the scheduled data-bot pushing to main at the same time.
#
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

NAME="${1:?usage: scripts/peanut.sh <Name> <Count>}"
COUNT="${2:?usage: scripts/peanut.sh <Name> <Count>}"

node - "$NAME" "$COUNT" <<'NODE'
const fs = require('fs');
const [,, name, countRaw] = process.argv;
const count = Number(countRaw);
if (!Number.isInteger(count) || count < 0) {
  console.error(`Count must be a whole number >= 0, got: ${countRaw}`);
  process.exit(1);
}
const path = 'config/peanuts.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!data.counts || !(name in data.counts)) {
  console.error(`Unknown name "${name}". Known: ${Object.keys(data.counts || {}).join(', ')}`);
  process.exit(1);
}
data.counts[name] = count;
const out = JSON.stringify(data, null, 2) + '\n';
fs.writeFileSync(path, out);
fs.writeFileSync('public/config/peanuts.json', out);
console.log(`${name} -> ${count}`);
NODE

# Nothing changed? Then there's nothing to publish.
if git diff --quiet -- config/peanuts.json public/config/peanuts.json; then
  echo "No change (already set) — nothing to push."
  exit 0
fi

git add config/peanuts.json public/config/peanuts.json
git commit -m "data: set peanut count for ${NAME} -> ${COUNT}"

# The scheduled fetch bot also pushes to main, so a single push can lose the
# race. Rebase + retry a few times before giving up.
for i in 1 2 3 4 5; do
  if git pull --rebase origin main && git push; then
    echo "Pushed. ${NAME} peanut count is now ${COUNT}."
    exit 0
  fi
  echo "push race with data bot, retrying ($i/5)..."
  sleep 2
done

echo "Push failed after 5 attempts." >&2
exit 1
