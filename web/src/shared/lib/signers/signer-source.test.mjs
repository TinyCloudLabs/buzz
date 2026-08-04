import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  DEVICE_ACCOUNT_ID,
  getDeviceAccount,
  signWithAccount,
} from "./signer-source.ts";
import { SignerError } from "./types.ts";

test.afterEach(() => {
  delete globalThis.window;
});

test("getDeviceAccount resolves the ephemeral pubkey with no NIP-07 provider", async () => {
  const account = await getDeviceAccount();
  assert.equal(account.kind, "device");
  assert.equal(account.id, DEVICE_ACCOUNT_ID);
  assert.match(account.pubkey, /^[0-9a-f]{64}$/);
  assert.equal(account.label, "This device");
});

test("getDeviceAccount labels a NIP-07 extension distinctly", async () => {
  globalThis.window = {
    nostr: {
      async getPublicKey() {
        return "ab".repeat(32);
      },
      async signEvent() {
        throw new Error("not used in this test");
      },
    },
  };
  const account = await getDeviceAccount();
  assert.equal(account.label, "This device (browser extension)");
  assert.equal(account.pubkey, "ab".repeat(32));
});

test("signWithAccount signs with the device path and returns a verified event", async () => {
  const account = await getDeviceAccount();
  const signed = await signWithAccount(account, {
    kind: 9,
    tags: [["h", "general"]],
    content: "hi from device",
  });
  assert.equal(signed.pubkey, account.pubkey);
  assert.equal(signed.content, "hi from device");
});

test("signWithAccount routes 'openkey' accounts through the injected OpenKeyClient and verifies the result", async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const account = {
    kind: "openkey",
    id: "key-1",
    pubkey: pk,
    npub: "npub1x",
    label: "OpenKey",
  };
  const fakeOpenKeyClient = {
    async signEvent(keyId, template) {
      assert.equal(keyId, "key-1");
      return finalizeEvent(template, sk);
    },
  };

  const signed = await signWithAccount(
    account,
    { kind: 9, tags: [["h", "general"]], content: "hi from openkey" },
    { openkey: fakeOpenKeyClient },
  );

  assert.equal(signed.pubkey, pk);
  assert.equal(signed.content, "hi from openkey");
});

test("signWithAccount rejects an OpenKey response signed by a different key than the selected account", async () => {
  const selectedAccount = {
    kind: "openkey",
    id: "key-1",
    pubkey: getPublicKey(generateSecretKey()),
    npub: "npub1x",
    label: "OpenKey",
  };
  const otherKey = generateSecretKey();
  const fakeOpenKeyClient = {
    async signEvent(_keyId, template) {
      // OpenKey (or a compromised iframe) signs with a different identity
      // than the one the caller selected.
      return finalizeEvent(template, otherKey);
    },
  };

  await assert.rejects(
    signWithAccount(
      selectedAccount,
      { kind: 9, tags: [], content: "x" },
      { openkey: fakeOpenKeyClient },
    ),
    (err) => {
      assert.ok(err instanceof SignerError);
      assert.match(err.message, /different pubkey/);
      return true;
    },
  );
});

test("signWithAccount rejects an OpenKey response with substituted tags", async () => {
  const sk = generateSecretKey();
  const account = {
    kind: "openkey",
    id: "key-1",
    pubkey: getPublicKey(sk),
    npub: "npub1x",
    label: "OpenKey",
  };
  const fakeOpenKeyClient = {
    async signEvent(_keyId, template) {
      return finalizeEvent(
        { ...template, tags: [["h", "different-channel"]] },
        sk,
      );
    },
  };

  await assert.rejects(
    signWithAccount(
      account,
      { kind: 9, tags: [["h", "general"]], content: "x" },
      { openkey: fakeOpenKeyClient },
    ),
    /different or reordered tags/,
  );
});
