/**
 * OpenKey Nostr signer — thin adapter around the real `@openkey/sdk`
 * (`OpenKeyNostr`, from `packages/sdk/src/nostr.ts` in the
 * openkey-nostr-signing repo). The postMessage/iframe protocol
 * implementation lives there now, not here — this module only owns:
 *
 *  - Buzz's own host resolution (`VITE_OPENKEY_HOST`, baked in at build
 *    time — see the Dockerfile's `web-builder` stage).
 *  - Mapping the SDK's `NostrError` onto Buzz's own `SignerError` so
 *    callers throughout `web/` only ever see one error shape regardless of
 *    signer source (device vs. OpenKey).
 *
 * `@openkey/sdk` itself is vendored in from the local OpenKey worktree
 * (never published, never hand-copied) — see `vendor/openkey-sdk`,
 * `harness/openkey-sdk/Dockerfile`, and the root Dockerfile's
 * `openkey-sdk-builder` stage, both of which build it from the same OpenKey
 * build context.
 *
 * Signed events returned by the SDK are NOT trusted here — every caller
 * runs them through `verifySignedEvent` (`./verify.ts`) before use. This
 * class only implements the request/response call, not the trust boundary.
 */
import { OpenKeyNostr } from "@openkey/sdk";
import type { NostrError, NostrIdentity } from "@openkey/sdk";

import { SignerError } from "./types";
import type { OpenKeyIdentity, UnsignedNostrEvent } from "./types";

const DEFAULT_OPENKEY_HOST = "https://openkey.so";

export function openKeyHost(): string {
  // Optional chaining: `import.meta.env` is always populated under Vite, but
  // this module is also loaded directly by node:test unit tests (no Vite
  // define/transform), where it's simply absent.
  const configured = import.meta.env?.VITE_OPENKEY_HOST;
  return configured && configured.length > 0
    ? configured
    : DEFAULT_OPENKEY_HOST;
}

function mapOpenKeyError(error: NostrError | undefined): SignerError {
  const code = error?.code;
  const mapped =
    code === "USER_CANCELLED"
      ? "USER_CANCELLED"
      : code === "TIMEOUT"
        ? "TIMEOUT"
        : code === "UNAUTHORIZED"
          ? "UNAUTHORIZED"
          : "UNKNOWN";
  return new SignerError(error?.message ?? "OpenKey request failed.", mapped);
}

function identityFromSdk(identity: NostrIdentity): OpenKeyIdentity {
  return {
    keyId: identity.keyId,
    pubkey: identity.pubkey,
    npub: identity.npub,
  };
}

export type OpenKeyNostrFactory = (host: string) => OpenKeyNostr;

/**
 * Browser client for the OpenKey Nostr custody + signing flow. Get an
 * instance from `new OpenKeyClient()` (default host) or inject a factory in
 * tests to avoid touching the real SDK's iframe/DOM machinery.
 */
export class OpenKeyClient {
  private sdk: OpenKeyNostr;

  constructor(
    host: string = openKeyHost(),
    createSdk: OpenKeyNostrFactory = (h) => new OpenKeyNostr(h),
  ) {
    this.sdk = createSdk(host);
  }

  /** Get-or-create the user's OpenKey-custodied Nostr identity. Always shows a consent card. */
  async connect(): Promise<OpenKeyIdentity> {
    try {
      const identity = await this.sdk.connect();
      return identityFromSdk(identity);
    } catch (err) {
      throw mapOpenKeyError(err as NostrError);
    }
  }

  /**
   * Sign a NIP-01 event template (including `pubkey` — the OpenKey API
   * checks it matches the signing key on record) with the given OpenKey
   * key. May be silent (existing grant) or show a consent card (first
   * message to a new origin/kind). The returned event is NOT verified here
   * — callers must run it through `verifySignedEvent`.
   */
  async signEvent(
    keyId: string,
    event: UnsignedNostrEvent & { pubkey: string },
  ): Promise<unknown> {
    try {
      return await this.sdk.signEvent(keyId, event);
    } catch (err) {
      throw mapOpenKeyError(err as NostrError);
    }
  }
}
