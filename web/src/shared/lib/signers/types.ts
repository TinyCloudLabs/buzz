/**
 * Canonical types for the signer-source abstraction.
 *
 * A "signer source" is anything that can produce a signed NIP-01 event for
 * the browser: the built-in device identity (NIP-07 extension, or a
 * page-lifetime ephemeral key as fallback) and OpenKey (a remote,
 * passkey-backed custodian reached over a sandboxed iframe). Every source
 * returns the same shapes below so callers never branch on "which signer"
 * beyond picking one.
 */

/** NIP-01 unsigned event template. */
export interface UnsignedNostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** A fully signed NIP-01 event. */
export interface SignedNostrEvent extends UnsignedNostrEvent {
  id: string;
  pubkey: string;
  sig: string;
}

/** Public descriptor for an OpenKey-custodied Nostr identity. Never includes a secret. */
export interface OpenKeyIdentity {
  keyId: string;
  pubkey: string;
  npub: string;
}

export type SignerKind = "device" | "openkey";

/**
 * Public descriptor for a selectable signer. Never carries key material —
 * only enough to display the option and route a signing request to the
 * right source.
 */
export interface SignerAccount {
  kind: SignerKind;
  /** Stable identifier within its kind ("device", or an OpenKey keyId). */
  id: string;
  pubkey: string;
  npub?: string;
  label: string;
}

export type SignerErrorCode =
  | "USER_CANCELLED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INVALID_RESPONSE"
  | "UNKNOWN";

// A plain field + assignment (not a constructor parameter property) so this
// file can be loaded as-is by node's `--experimental-strip-types` in unit
// tests, which only strips type syntax and does not support the extra code
// parameter properties emit.
export class SignerError extends Error {
  readonly code: SignerErrorCode;

  constructor(message: string, code: SignerErrorCode = "UNKNOWN") {
    super(message);
    this.name = "SignerError";
    this.code = code;
  }
}
