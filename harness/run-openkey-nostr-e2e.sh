#!/usr/bin/env bash
set -euo pipefail

BUZZ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$BUZZ_ROOT/docker-compose.openkey.yml}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

for command in docker bun pnpm git; do
  require_command "$command"
done

if [[ -z "${OPENKEY_REPO_PATH:-}" ]]; then
  cat >&2 <<'EOF'
OPENKEY_REPO_PATH is required and must name a clean local OpenKey checkout.
Example: OPENKEY_REPO_PATH=../openkey ./harness/run-openkey-nostr-e2e.sh
EOF
  exit 1
fi

if [[ ! -f "$OPENKEY_REPO_PATH/package.json" ]] || ! git -C "$OPENKEY_REPO_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "OPENKEY_REPO_PATH is not an OpenKey checkout: $OPENKEY_REPO_PATH" >&2
  exit 1
fi

OPENKEY_REPO_PATH="$(cd "$OPENKEY_REPO_PATH" && pwd -P)"
if ! git -C "$OPENKEY_REPO_PATH" diff --quiet || ! git -C "$OPENKEY_REPO_PATH" diff --cached --quiet; then
  echo "OPENKEY_REPO_PATH must be clean; commit or stash its tracked changes first." >&2
  exit 1
fi

# Each run receives fresh Compose volumes. This prevents a previous database,
# image, or generated artifact from becoming an unstated test prerequisite.
COMPOSE_PROJECT_NAME="${BUZZ_OPENKEY_COMPOSE_PROJECT:-buzz-openkey-e2e-$$}"
compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")

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
    container_id="$("${compose[@]}" ps -q "$service")"
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

# A clean checkout is a supported entry point. Do not require a contributor to
# infer or pre-create host dependencies before running the public browser flow.
pnpm install --frozen-lockfile
(
  cd "$OPENKEY_REPO_PATH"
  bun install --frozen-lockfile
)

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

# Build every service from registry sources with no reusable BuildKit layer,
# then start the newly built images. The happy-path result therefore cannot be
# supplied by an earlier image, cache, volume, or ignored generated output.
"${compose[@]}" build --pull --no-cache
"${compose[@]}" up -d --force-recreate --no-build

wait_for_compose_health "buzz"
wait_for_compose_health "openkey-api"
wait_for_compose_health "openkey-web"
wait_for_http "$BUZZ_WEB_URL/invite/openkey-harness" "Buzz web"
wait_for_http "http://localhost:3001/health" "OpenKey API health"
wait_for_http "http://localhost:5173/widget/embed/nostr/approve?origin=http%3A%2F%2Flocalhost%3A3000" "OpenKey web"

pnpm -C web exec playwright test --project=openkey-nostr
