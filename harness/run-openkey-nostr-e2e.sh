#!/usr/bin/env bash
set -euo pipefail

BUZZ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENKEY_REPO_PATH="${OPENKEY_REPO_PATH:-/Users/samgbafa/conductor/workspaces/tinycloud-dev/perth/worktrees/openkey/feat/openkey-nostr-signing}"
COMPOSE_FILE="${COMPOSE_FILE:-$BUZZ_ROOT/docker-compose.openkey.yml}"

export OPENKEY_REPO_PATH
export BUZZ_WEB_URL="${BUZZ_WEB_URL:-http://localhost:3000}"
export OPENKEY_API_URL="${OPENKEY_API_URL:-http://localhost:3001}"
export OPENKEY_URL="${OPENKEY_URL:-http://localhost:5173}"
export RELAY_WS_URL="${RELAY_WS_URL:-ws://localhost:3000}"
export BUZZ_E2E_DOCKER=1

wait_for_http() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for $name at $url" >&2
  return 1
}

wait_for_compose_health() {
  local service="$1"
  for _ in $(seq 1 90); do
    local container_id
    container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$service")"
    if [[ -n "$container_id" ]]; then
      local status
      status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
      if [[ "$status" == "healthy" || "$status" == "running" ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "Timed out waiting for compose service $service to become healthy" >&2
  return 1
}

cd "$BUZZ_ROOT"

if [[ -f "$BUZZ_ROOT/bin/activate-hermit" ]]; then
  # shellcheck disable=SC1091
  . "$BUZZ_ROOT/bin/activate-hermit"
fi

docker compose -f "$COMPOSE_FILE" build openkey-sdk-vendor
docker compose -f "$COMPOSE_FILE" run --rm openkey-sdk-vendor

pnpm -C web typecheck
pnpm -C web test

(
  cd "$OPENKEY_REPO_PATH"
  bun test \
    packages/tee/tests/nostr.test.ts \
    packages/tee/tests/nostr-secret-zeroing.test.ts \
    apps/api/src/__tests__/nostr-keys.test.ts \
    tests/nostr-origin.test.ts
)

if [[ "${BUZZ_HARNESS_COMPOSE_BUILD:-1}" == "1" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d --build --force-recreate
else
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build
fi

wait_for_compose_health "buzz"
wait_for_compose_health "openkey-api"
wait_for_compose_health "openkey-web"
wait_for_http "$BUZZ_WEB_URL/invite/openkey-harness" "Buzz web"
wait_for_http "http://localhost:3001/health" "OpenKey API health"
wait_for_http "http://localhost:5173/widget/embed/nostr/approve?origin=http%3A%2F%2Flocalhost%3A3000" "OpenKey web"

pnpm -C web exec playwright test --project=openkey-nostr
