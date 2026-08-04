import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  getDevicePublicKey,
  hasNip07Provider,
  signNostrEvent,
} from "./nostr-signer.ts";

// This module reads the ambient `window` global. Node's test environment has
// none by default (that's what exercises the ephemeral-key fallback below);
// these helpers add/remove a fake one to exercise the NIP-07 branch.
function installNip07(provider) {
  globalThis.window = { nostr: provider };
}
function removeNip07() {
  delete globalThis.window;
}

test.afterEach(() => {
  removeNip07();
});

test("hasNip07Provider is false with no window.nostr", () => {
  assert.equal(hasNip07Provider(), false);
});

test("hasNip07Provider is true once a provider is installed", () => {
  installNip07({ async getPublicKey() {}, async signEvent() {} });
  assert.equal(hasNip07Provider(), true);
});

test("signNostrEvent falls back to a real, independently-verifiable ephemeral key with no NIP-07 provider", async () => {
  const signed = await signNostrEvent({
    kind: 1,
    tags: [],
    content: "hello from the ephemeral key",
  });

  assert.equal(signed.content, "hello from the ephemeral key");
  assert.equal(await getDevicePublicKey(), signed.pubkey);
});

test("signNostrEvent accepts a genuinely valid NIP-07 response", async () => {
  const sk = new Uint8Array(32).fill(7);
  const pk = getPublicKey(sk);
  installNip07({
    async getPublicKey() {
      return pk;
    },
    async signEvent(event) {
      return finalizeEvent(event, sk);
    },
  });

  const signed = await signNostrEvent({
    kind: 1,
    tags: [["h", "general"]],
    content: "hi",
  });

  assert.equal(signed.pubkey, pk);
  assert.equal(await getDevicePublicKey(), pk);
});

test("signNostrEvent rejects a NIP-07 response signed by a different pubkey than getPublicKey() promised", async () => {
  const realKey = new Uint8Array(32).fill(1);
  const wrongKey = new Uint8Array(32).fill(2);
  installNip07({
    async getPublicKey() {
      return getPublicKey(realKey);
    },
    async signEvent(event) {
      // A misbehaving/compromised extension signs with a different key than
      // the one it claimed via getPublicKey().
      return finalizeEvent(event, wrongKey);
    },
  });

  await assert.rejects(
    signNostrEvent({ kind: 1, tags: [], content: "x" }),
    /different pubkey/,
  );
});

test("signNostrEvent rejects a NIP-07 response with substituted content", async () => {
  const sk = new Uint8Array(32).fill(3);
  installNip07({
    async getPublicKey() {
      return getPublicKey(sk);
    },
    async signEvent(event) {
      // Extension signs *something*, but not the template it was asked to.
      return finalizeEvent({ ...event, content: "swapped" }, sk);
    },
  });

  await assert.rejects(
    signNostrEvent({ kind: 1, tags: [], content: "original" }),
    /different content/,
  );
});

test("signNostrEvent rejects a NIP-07 response with a garbage signature", async () => {
  const sk = new Uint8Array(32).fill(4);
  const pk = getPublicKey(sk);
  installNip07({
    async getPublicKey() {
      return pk;
    },
    async signEvent(event) {
      return {
        ...event,
        id: "0".repeat(64),
        pubkey: pk,
        sig: "0".repeat(128),
      };
    },
  });

  await assert.rejects(
    signNostrEvent({ kind: 1, tags: [], content: "x" }),
    /content hash|Schnorr/,
  );
});

test("signNostrEvent requires NIP-07 when requireNip07 is set and none is installed", async () => {
  await assert.rejects(
    signNostrEvent({ kind: 1, tags: [], content: "x" }, { requireNip07: true }),
    /NIP-07/,
  );
});
