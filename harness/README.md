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

Run from the Buzz worktree:

```bash
OPENKEY_REPO_PATH=/Users/samgbafa/conductor/workspaces/tinycloud-dev/perth/worktrees/openkey/feat/openkey-nostr-signing \
  ./harness/run-openkey-nostr-e2e.sh
```

What it does:

- Builds and exports the local `@openkey/sdk` from the OpenKey worktree through
  `harness/openkey-sdk/Dockerfile`.
- Runs focused Buzz web typecheck/unit coverage and focused OpenKey Nostr
  route/origin/TEE tests.
- Recreates `docker-compose.openkey.yml` with `--build --force-recreate`,
  preserving Docker volumes.
- Requires Buzz readiness, OpenKey API health, and OpenKey web availability.
- Runs `web/tests/e2e/openkey-nostr.spec.ts` with `BUZZ_E2E_DOCKER=1`.

Evidence is written under `harness/evidence/`:

- milestone log with identity, grant, revoke, query, and verification evidence
- raw relay WebSocket frames observed by Playwright
- Nostr-flow `postMessage` records used for secret and target-origin checks

The stack is intentionally left running for inspection after the harness exits.

For a rerun against already rebuilt local images, set
`BUZZ_HARNESS_COMPOSE_BUILD=0`; the script still force-recreates the Compose
services with existing images and preserves volumes.
