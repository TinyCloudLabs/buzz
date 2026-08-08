# OpenKey Nostr Signing Harness

`run-openkey-nostr-e2e.sh` is the executable local harness for the Buzz
OpenKey integration. It runs against Docker-served Buzz and the real
cross-origin OpenKey web widget:

- Buzz relay + web: `http://localhost:3000` / `ws://localhost:3000`
- OpenKey API: `http://localhost:3001`
- OpenKey web iframe: `http://localhost:5173`

The harness intentionally drives the OpenKey UI for auth and consent:
`test@openkey.dev`, OTP `000000`, identity connect, kind-22242 relay auth,
first kind-9 consent, and second silent kind-9 signing. It does not seed relay
event tables, mock crypto, fake relay ACKs, use Paseo, deploy, publish, push,
open a PR, or bypass the OpenKey UI path.

## Run the real browser flow

From a Buzz checkout, one command prepares frozen host dependencies, builds
fresh Docker images and volumes, and runs the real Playwright browser flow.
It deliberately has no machine-specific default path and does not consume a
prebuilt SDK artifact:

```bash
OPENKEY_REPO_PATH=../openkey ./harness/run-openkey-nostr-e2e.sh
```

`OPENKEY_REPO_PATH` may be any clean local OpenKey clone or worktree. The
runner fails before it changes Docker state when it is missing, not an OpenKey
checkout, or has tracked changes. Required commands are Docker Compose, Bun,
pnpm, and Git; activate Buzz's Hermit toolchain first when those tools are not
already on `PATH`:

```bash
. ./bin/activate-hermit
OPENKEY_REPO_PATH=../openkey ./harness/run-openkey-nostr-e2e.sh
```

What it does:

- Runs `pnpm install --frozen-lockfile` for Buzz and `bun install
  --frozen-lockfile` for OpenKey, so a clean checkout needs no hidden host
  preparation.
- Runs focused Buzz web typecheck/unit coverage and focused OpenKey Nostr
  route/origin/TEE tests.
- Builds Compose images with `--pull --no-cache` and starts a uniquely named
  Compose project with fresh volumes. It does not use a previous image,
  BuildKit cache, Docker volume, or ignored generated SDK output.
- Requires Buzz readiness, OpenKey API health, and OpenKey web availability.
- Runs `web/tests/e2e/openkey-nostr.spec.ts` with `BUZZ_E2E_DOCKER=1`.

Evidence is written under `harness/evidence/`:

- milestone log with identity, grant, revoke, query, and verification evidence
- raw relay WebSocket frames observed by Playwright
- Nostr-flow `postMessage` records used for secret and target-origin checks

The stack is intentionally left running for inspection after the harness exits.
Set `BUZZ_OPENKEY_COMPOSE_PROJECT` only when an explicit, stable Compose
project name is needed for inspection; use a new name for another clean run.
