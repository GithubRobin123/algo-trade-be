#!/usr/bin/env bash
# Deploys algo-trade-be on the EC2 server.
# Run by .github/workflows/deploy-backend.yml over SSH, or by hand on the server:
#
#   bash scripts/deploy.sh main            deploy branch "main"
#   bash scripts/deploy.sh main --check    only verify prerequisites, change nothing
#
# Steps:
#   1. refuse if the server checkout has local edits (never overwrite changes made on the server)
#   2. fast-forward to origin/<branch>
#   3. npm ci only when package.json / package-lock.json changed
#   4. build into dist-next/ and swap it in only after a successful build (old dist kept as dist-prev/)
#   5. restart ONLY the pm2 app "algo-backend" — cf-tunnel (and the game) are never touched,
#      so the public tunnel URL does not change
#   6. health check on localhost; on failure roll back code + dist and restart the previous version
#
# Everything runs inside main(), so bash has read the whole script before the first command —
# safe when the script is piped over SSH (`ssh host "bash -s" < deploy.sh`).
set -euo pipefail

BRANCH="${1:-main}"
MODE="${2:-deploy}"
APP_DIR="${APP_DIR:-$HOME/algo-trade-be}"
PM2_APP="${PM2_APP:-algo-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-90}"
PREV=""
NEXT=""

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { log "ERROR: $*"; exit 1; }

health_ok() {
  local _
  for _ in $(seq 1 "$HEALTH_TIMEOUT_S"); do
    curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

deps_changed() { ! git diff --quiet "$PREV" "$NEXT" -- package.json package-lock.json; }

rollback() {
  log "ROLLING BACK to $(git rev-parse --short "$PREV")"
  git reset -q --hard "$PREV"
  if [[ -d dist-prev ]]; then rm -rf dist; mv dist-prev dist; fi
  rm -rf dist-next
  if deps_changed; then npm ci --include=dev --no-audit --no-fund; fi
  pm2 restart "$PM2_APP" >/dev/null
  if health_ok; then
    log "rolled back; previous version is healthy"
  else
    log "previous version is ALSO unhealthy; check: pm2 logs $PM2_APP"
  fi
  exit 1
}

main() {
  [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid branch name: $BRANCH"
  [[ "$PM2_APP" != "all" ]] || fail "refusing to restart all pm2 apps"
  command -v pm2 >/dev/null 2>&1 || fail "pm2 not found"
  cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR not found"
  pm2 describe "$PM2_APP" >/dev/null 2>&1 || fail "pm2 app '$PM2_APP' not found"
  [[ -f .env ]] || fail ".env missing in $APP_DIR"

  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    git status --short --untracked-files=no
    fail "server checkout has local changes; commit or discard them on the server first"
  fi

  git fetch --prune -q origin
  git rev-parse --verify -q "origin/$BRANCH" >/dev/null || fail "branch origin/$BRANCH not found"

  PREV="$(git rev-parse HEAD)"
  NEXT="$(git rev-parse "origin/$BRANCH")"
  log "server at $(git rev-parse --short "$PREV"), target $(git rev-parse --short "$NEXT") ($BRANCH)"

  if [[ "$MODE" == "--check" ]]; then
    log "node $(node --version), npm $(npm --version), free disk $(df -h . | awk 'NR==2{print $4}'), pm2 app '$PM2_APP' found"
    git log --oneline "$PREV..$NEXT" | sed 's/^/  pending: /'
    log "check passed; nothing was changed"
    return 0
  fi

  if [[ "$PREV" == "$NEXT" && -f dist/build-info.json ]]; then
    log "already deployed at $(git rev-parse --short "$NEXT"); nothing to do"
    return 0
  fi

  git checkout -q "$BRANCH"
  git merge --ff-only -q "origin/$BRANCH" || fail "cannot fast-forward $BRANCH (server history diverged from origin)"

  if deps_changed; then
    log "dependencies changed: npm ci"
    npm ci --include=dev --no-audit --no-fund || rollback
  fi

  log "building into dist-next/"
  rm -rf dist-next
  npx tsc -p tsconfig.json --outDir dist-next || rollback
  [[ -f dist-next/index.js ]] || rollback
  printf '{"commit":"%s","branch":"%s","deployedAt":"%s"}\n' \
    "$(git rev-parse --short HEAD)" "$BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist-next/build-info.json

  rm -rf dist-prev
  if [[ -d dist ]]; then mv dist dist-prev; fi
  mv dist-next dist

  log "restarting pm2 app '$PM2_APP' only (cf-tunnel untouched)"
  pm2 restart "$PM2_APP" >/dev/null || rollback

  if ! health_ok; then
    log "health check failed after ${HEALTH_TIMEOUT_S}s; last logs:"
    pm2 logs "$PM2_APP" --lines 40 --nostream || true
    rollback
  fi

  pm2 save >/dev/null 2>&1 || true
  log "deployed $(git rev-parse --short HEAD); health OK"
}

main </dev/null
