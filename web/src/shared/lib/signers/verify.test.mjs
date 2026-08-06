import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifiedSymbol,
} from "nostr-tools/pure";

import { SignerError } from "./types.ts";
import { verifySignedEvent } from "./verify.ts";

function template(overrides = {}) {
  return {
    kind: 9,
    created_at: 1_700_000_000,
    tags: [["h", "general"]],
    content: "hello, channel",
    ...overrides,
  };
}

function sign(secretKey, unsigned) {
  return finalizeEvent(unsigned, secretKey);
}

test("verifySignedEvent accepts a genuinely valid signed event", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signed = sign(sk, unsigned);

  const verified = verifySignedEvent(unsigned, signed, pk);

  assert.equal(verified.id, signed.id);
  assert.equal(verified.pubkey, pk);
  assert.equal(verified.sig, signed.sig);
});

test("verifySignedEvent rejects a malformed candidate", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();

  assert.throws(
    () => verifySignedEvent(unsigned, { not: "an event" }, pk),
    SignerError,
  );
});

test("verifySignedEvent rejects an event signed by a different pubkey than selected", () => {
  const signerKey = generateSecretKey();
  const otherKey = generateSecretKey();
  const unsigned = template();
  const signed = sign(signerKey, unsigned);

  assert.throws(() => {
    verifySignedEvent(unsigned, signed, getPublicKey(otherKey));
  }, /different pubkey/);
});

test("verifySignedEvent rejects a substituted kind", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  // A malicious/buggy signer signs a *different* kind than requested, but
  // the id/sig over that substituted event are internally consistent.
  const signedWrongKind = sign(sk, template({ kind: 1 }));

  assert.throws(() => {
    verifySignedEvent(unsigned, signedWrongKind, pk);
  }, /different kind/);
});

test("verifySignedEvent rejects a substituted created_at", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signedWrongTime = sign(sk, template({ created_at: 1_800_000_000 }));

  assert.throws(() => {
    verifySignedEvent(unsigned, signedWrongTime, pk);
  }, /different created_at/);
});

test("verifySignedEvent rejects substituted content", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signedWrongContent = sign(
    sk,
    template({ content: "not what I typed" }),
  );

  assert.throws(() => {
    verifySignedEvent(unsigned, signedWrongContent, pk);
  }, /different content/);
});

test("verifySignedEvent rejects a different tag value even with a validly-signed event", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signedWrongTag = sign(sk, template({ tags: [["h", "other-channel"]] }));

  assert.throws(() => {
    verifySignedEvent(unsigned, signedWrongTag, pk);
  }, /different or reordered tags/);
});

test("verifySignedEvent rejects reordered tags, not just different tag sets", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template({
    tags: [
      ["h", "general"],
      ["client", "buzz-web"],
    ],
  });
  const signedReordered = sign(
    sk,
    template({
      tags: [
        ["client", "buzz-web"],
        ["h", "general"],
      ],
    }),
  );

  assert.throws(() => {
    verifySignedEvent(unsigned, signedReordered, pk);
  }, /different or reordered tags/);
});

test("verifySignedEvent rejects an id that doesn't hash to the event content", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signed = sign(sk, unsigned);
  const tamperedId = { ...signed, id: "0".repeat(64) };

  assert.throws(() => {
    verifySignedEvent(unsigned, tamperedId, pk);
  }, /content hash/);
});

test("verifySignedEvent rejects an invalid Schnorr signature even when id/pubkey/content match", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signed = sign(sk, unsigned);
  // Flip the signature but keep the (still content-matching) id as-is. Build
  // a fresh object (not a spread of `signed`) so nostr-tools' internal
  // "already verified" cache — set by `finalizeEvent` and keyed by a Symbol
  // that spreads copy along with everything else — doesn't short-circuit
  // this from actually exercising signature verification.
  const tamperedSig = {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: `${"0".repeat(127)}1`,
  };

  assert.throws(() => {
    verifySignedEvent(unsigned, tamperedSig, pk);
  }, SignerError);
});

test("verifySignedEvent is not fooled by a forged nostr-tools verification cache", () => {
  // finalizeEvent marks its output as pre-verified via an exported Symbol
  // (nostr-tools/pure's `verifiedSymbol`) so a later verifyEvent call on the
  // *same object* can skip re-checking the signature. That Symbol is
  // importable by anything sharing the page's module graph — including a
  // NIP-07 extension injected directly into the page realm — so a forged
  // event carrying a garbage signature plus a spoofed
  // `[verifiedSymbol]: true` could otherwise short-circuit past the real
  // Schnorr check. verify.ts must ignore any such cache.
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  const signed = sign(sk, unsigned); // genuinely valid: id matches content hash
  const forged = {
    ...unsigned,
    id: signed.id,
    pubkey: signed.pubkey,
    sig: "1".repeat(128), // garbage — does not correspond to signed.id
  };
  forged[verifiedSymbol] = true;

  assert.throws(() => {
    verifySignedEvent(unsigned, forged, pk);
  }, /Schnorr signature/);
});

test("verifySignedEvent rejects a candidate signed over someone else's event but relabelled as this one", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const unsigned = template();
  // Sign a *completely different* event, then relabel its fields to look
  // like the requested template while keeping the original id/sig — the
  // recomputed id must not match, independent of the field-by-field checks.
  const decoySigned = sign(sk, template({ content: "decoy" }));
  const relabelled = {
    ...decoySigned,
    ...unsigned,
    id: decoySigned.id,
    sig: decoySigned.sig,
  };

  assert.throws(() => {
    verifySignedEvent(unsigned, relabelled, pk);
  }, SignerError);
});
