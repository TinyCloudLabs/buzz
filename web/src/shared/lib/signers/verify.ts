/**
 * Strict, independent verification of signer output.
 *
 * No signer response is trusted at face value — not the NIP-07 extension,
 * not the page-lifetime ephemeral key, and not OpenKey's iframe. Every
 * signed event is re-derived from scratch with nostr-tools and compared
 * field-by-field against what was actually requested:
 *
 *   - id: recomputed from the event's own serialization (NIP-01 §"id"),
 *     never trusted from the payload.
 *   - sig: Schnorr-verified against the recomputed id and the event's pubkey
 *     (BIP-340 / NIP-01).
 *   - pubkey: must equal the pubkey of the signer account the caller
 *     selected — a signer cannot silently sign as someone else.
 *   - kind / created_at / content / tags: must exactly match the requested
 *     template, tag order included, so a compromised or buggy signer can't
 *     substitute content while keeping a "valid" signature over its own
 *     substituted fields.
 */
import { getEventHash, validateEvent, verifyEvent } from "nostr-tools/pure";

import { SignerError } from "./types";
import type { SignedNostrEvent, UnsignedNostrEvent } from "./types";

function tagsEqual(a: string[][], b: string[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const rowA = a[i];
    const rowB = b[i];
    if (rowA.length !== rowB.length) return false;
    for (let j = 0; j < rowA.length; j++) {
      if (rowA[j] !== rowB[j]) return false;
    }
  }
  return true;
}

/**
 * Verify a candidate signed event against the exact template that was
 * requested and the pubkey of the signer that was selected. Throws
 * `SignerError` (code `INVALID_RESPONSE`) on any mismatch. Returns the
 * candidate, narrowed to `SignedNostrEvent`, on success.
 */
export function verifySignedEvent(
  requested: UnsignedNostrEvent,
  candidate: unknown,
  expectedPubkey: string,
): SignedNostrEvent {
  if (!validateEvent(candidate)) {
    throw new SignerError(
      "Signer returned a malformed event.",
      "INVALID_RESPONSE",
    );
  }
  const event = candidate as SignedNostrEvent;

  if (typeof event.id !== "string" || typeof event.sig !== "string") {
    throw new SignerError(
      "Signer returned an event with no id or signature.",
      "INVALID_RESPONSE",
    );
  }
  if (event.pubkey !== expectedPubkey) {
    throw new SignerError(
      "Signer returned an event signed by a different pubkey than selected.",
      "INVALID_RESPONSE",
    );
  }
  if (event.kind !== requested.kind) {
    throw new SignerError(
      "Signer returned an event with a different kind than requested.",
      "INVALID_RESPONSE",
    );
  }
  if (event.created_at !== requested.created_at) {
    throw new SignerError(
      "Signer returned an event with a different created_at than requested.",
      "INVALID_RESPONSE",
    );
  }
  if (event.content !== requested.content) {
    throw new SignerError(
      "Signer returned an event with different content than requested.",
      "INVALID_RESPONSE",
    );
  }
  if (!tagsEqual(event.tags, requested.tags)) {
    throw new SignerError(
      "Signer returned an event with different or reordered tags than requested.",
      "INVALID_RESPONSE",
    );
  }

  // Rebuild a plain object with only the NIP-01 fields before running it
  // through nostr-tools' crypto checks. `finalizeEvent`/`verifyEvent` cache
  // their result on the event object under an exported `verifiedSymbol`
  // (`nostr-tools/pure`), so repeated `verifyEvent` calls on the same object
  // skip re-checking the signature. That symbol is importable by any code
  // sharing the page's module graph — including a NIP-07 extension injected
  // directly into the page realm — so a forged event carrying a spoofed
  // `[verifiedSymbol]: true` would otherwise bypass verification entirely.
  // A freshly constructed object literal has no symbol-keyed properties, so
  // `verifyEvent` always performs the real check here.
  const sanitized = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };

  const recomputedId = getEventHash(sanitized);
  if (recomputedId !== sanitized.id) {
    throw new SignerError(
      "Signer returned an event whose id does not match its content hash.",
      "INVALID_RESPONSE",
    );
  }
  if (!verifyEvent(sanitized)) {
    throw new SignerError(
      "Signer returned an event with an invalid Schnorr signature.",
      "INVALID_RESPONSE",
    );
  }

  return sanitized;
}
