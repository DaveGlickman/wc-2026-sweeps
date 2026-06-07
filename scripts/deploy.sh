#!/usr/bin/env bash
#
# One-command deploy for World Cup 2026 Sweeps.
#
# Does everything on the GitHub side that does NOT require your API key:
#   1. creates the GitHub repo (if it doesn't exist) and pushes this commit
#   2. sets the Pages source to "GitHub Actions" (so pages.yml publishes ./public)
#   3. prints the Pages URL and a reminder of the two things only you can do
#
# Prerequisites:
#   - gh CLI installed and authenticated:  gh auth login
#   - run from the repo root
#
# Usage:
#   scripts/deploy.sh <repo-name> [--public|--private]
# Example:
#   scripts/deploy.sh wc-2026-sweeps --public
#
# Note: GitHub Pages on a PRIVATE repo requires a paid plan (Pro/Team). On a
# free account use --public (default) so the Pages URL works.

set -euo pipefail

# gh may be installed in ~/.local/bin (non-sudo install) which isn't always on PATH.
export PATH="$HOME/.local/bin:$PATH"

REPO_NAME="${1:-}"
VISIBILITY="${2:---public}"

if [[ -z "$REPO_NAME" ]]; then
  echo "Usage: scripts/deploy.sh <repo-name> [--public|--private]" >&2
  exit 1
fi
case "$VISIBILITY" in
  --public|--private) ;;
  *) echo "Second arg must be --public or --private" >&2; exit 1 ;;
esac

command -v gh >/dev/null 2>&1 || { echo "gh CLI not found. Install it, then 'gh auth login'." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not authenticated. Run 'gh auth login' first." >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Run this from inside the git repo." >&2; exit 1; }

OWNER="$(gh api user --jq .login)"
echo "==> GitHub user: $OWNER"

# 1. Create + push (idempotent: if the repo already exists, just add the remote and push).
if gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  echo "==> Repo $OWNER/$REPO_NAME already exists; pushing."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
  git push -u origin HEAD:main
else
  echo "==> Creating $VISIBILITY repo $OWNER/$REPO_NAME and pushing."
  gh repo create "$REPO_NAME" "$VISIBILITY" --source=. --remote=origin --push
fi

# 2. Set Pages source to GitHub Actions (build_type=workflow). POST creates it;
#    if Pages already exists, fall back to PUT to update.
echo "==> Enabling GitHub Pages (source: GitHub Actions)."
if ! gh api -X POST "repos/$OWNER/$REPO_NAME/pages" -f build_type=workflow >/dev/null 2>&1; then
  gh api -X PUT "repos/$OWNER/$REPO_NAME/pages" -f build_type=workflow >/dev/null 2>&1 || true
fi

# 3. Report.
PAGE_URL="$(gh api "repos/$OWNER/$REPO_NAME/pages" --jq .html_url 2>/dev/null || true)"
echo
echo "============================================================"
echo " Repo:  https://github.com/$OWNER/$REPO_NAME"
echo " Pages: ${PAGE_URL:-"(building — check Settings → Pages in ~1 min)"}"
echo "============================================================"
echo
echo "STILL REQUIRED (only you can do these):"
echo "  1. Add the API key secret:"
echo "       gh secret set API_FOOTBALL_KEY --repo $OWNER/$REPO_NAME"
echo "     (or Settings → Secrets and variables → Actions → New repository secret)"
echo "  2. Fill config/allocations.json and config/picks.json with the draw results,"
echo "     commit, and push. Optionally validate first:"
echo "       API_FOOTBALL_KEY=xxx node scripts/verify-picks.js"
echo
echo "Then trigger the first data fetch:"
echo "  gh workflow run 'Fetch World Cup data' --repo $OWNER/$REPO_NAME"
