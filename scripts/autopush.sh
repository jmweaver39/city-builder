#!/bin/zsh
# Commits the project whenever it typechecks cleanly, and pushes to GitHub once
# `gh` is logged in. Creates the private repo on first run if there is no remote.
#   AUTOPUSH_INTERVAL  seconds between checks (default 180)
#   AUTOPUSH_REPO      repo name to create (default cloverleaf)

cd "${0:A:h}/.." || exit 1
interval=${AUTOPUSH_INTERVAL:-180}
repo=${AUTOPUSH_REPO:-cloverleaf}

log() { print -r -- "$(date +%H:%M:%S) $*"; }

while true; do
  if [[ -n "$(git status --porcelain)" ]]; then
    if npx tsc --noEmit >/dev/null 2>&1; then
      git add -A
      count=$(git diff --cached --name-only | wc -l | tr -d ' ')
      git commit -q -m "Auto-sync: $count files changed" \
        -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && log "committed $count files"
    else
      log "typecheck failing, waiting before committing"
    fi
  fi

  if git rev-parse -q --verify HEAD >/dev/null && gh auth status >/dev/null 2>&1; then
    if ! git remote get-url origin >/dev/null 2>&1; then
      gh repo create "$repo" --private --source . --remote origin >/dev/null && log "created GitHub repo $repo"
    fi
    if ! git ls-remote --exit-code --heads origin main >/dev/null 2>&1 \
      || [[ $(git rev-list --count origin/main..main 2>/dev/null || print 1) -gt 0 ]]; then
      git push -q -u origin main && log "pushed"
    fi
  fi

  sleep "$interval"
done
