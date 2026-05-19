#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/root/projects/agents-sales-back}"
DEPLOY_BACKEND_DIR="${DEPLOY_BACKEND_DIR:-/root/.openclaw/workspace/projects/agents-sales/backend}"
COMPOSE_DIR="${COMPOSE_DIR:-/root/.openclaw/workspace/projects/agents-sales}"
APP_URL="${APP_URL:-http://127.0.0.1:${BACKEND_PORT:-3202}/api/bot/config?channel=whatsapp&account=ACCOUNT_WA_DEMO&phone=51999999999}"
TARGET_BRANCH="${TARGET_BRANCH:-master}"

printf '==> Updating source repo in %s\n' "$REPO_DIR"
git -C "$REPO_DIR" fetch origin
CURRENT_BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]; then
  git -C "$REPO_DIR" checkout "$TARGET_BRANCH"
fi
git -C "$REPO_DIR" pull --ff-only origin "$TARGET_BRANCH"

printf '==> Syncing sources to deploy dir %s\n' "$DEPLOY_BACKEND_DIR"
mkdir -p "$DEPLOY_BACKEND_DIR"
rsync -av --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  "$REPO_DIR/" "$DEPLOY_BACKEND_DIR/"

printf '==> Building and restarting backend container\n'
docker compose -f "$COMPOSE_DIR/docker-compose.yml" build backend
docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d backend

printf '==> Waiting for backend to settle\n'
sleep 5

printf '==> Verifying backend container is running\n'
docker compose -f "$COMPOSE_DIR/docker-compose.yml" ps backend

printf '==> Verifying app endpoint %s\n' "$APP_URL"
for attempt in $(seq 1 12); do
  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$APP_URL" || true)"
  if [ "$HTTP_CODE" != "000" ]; then
    printf '==> Healthcheck responded with HTTP %s\n' "$HTTP_CODE"
    break
  fi

  if [ "$attempt" -eq 12 ]; then
    echo '==> Healthcheck did not receive an HTTP response in time'
    exit 1
  fi

  printf '==> Healthcheck not ready yet (attempt %s/12), retrying...\n' "$attempt"
  sleep 5
done

printf '==> Backend deployment completed successfully\n'
