import assert from "node:assert/strict";
import test from "node:test";

import { OpenKeyClient } from "./openkey-client.ts";
import { SignerError } from "./types.ts";

/**
 * A fake `OpenKeyNostr` (the real SDK class) so these tests exercise only
 * `OpenKeyClient`'s own responsibilities — host resolution and
 * `SignerError` mapping — without touching the SDK's real iframe/postMessage
 * implementation (that's covered by the SDK's own test suite in the
 * openkey-nostr-signing repo).
 */
function makeFakeSdk() {
  const calls = { connect: [], signEvent: [] };
  let connectImpl = async () => {
    throw new Error("connect() not stubbed");
  };
  let signEventImpl = async () => {
    throw new Error("signEvent() not stubbed");
  };
  return {
    calls,
    connect(...args) {
      calls.connect.push(args);
      return connectImpl(...args);
    },
    signEvent(...args) {
      calls.signEvent.push(args);
      return signEventImpl(...args);
    },
    onConnect(impl) {
      connectImpl = impl;
    },
    onSignEvent(impl) {
      signEventImpl = impl;
    },
  };
}

function makeClient() {
  const sdk = makeFakeSdk();
  const client = new OpenKeyClient("https://openkey.test", () => sdk);
  return { client, sdk };
}

test("connect() resolves with the SDK's identity, narrowed to keyId/pubkey/npub", async () => {
  const { client, sdk } = makeClient();
  sdk.onConnect(async () => ({
    keyId: "key-1",
    pubkey: "ab".repeat(32),
    npub: "npub1exampleexample",
  }));

  const identity = await client.connect();
  assert.deepEqual(identity, {
    keyId: "key-1",
    pubkey: "ab".repeat(32),
    npub: "npub1exampleexample",
  });
});

test("connect() rejects with a mapped SignerError on SDK failure", async () => {
  const { client, sdk } = makeClient();
  sdk.onConnect(async () => {
    throw { code: "USER_CANCELLED", message: "User closed the widget." };
  });

  await assert.rejects(client.connect(), (err) => {
    assert.ok(err instanceof SignerError);
    assert.equal(err.code, "USER_CANCELLED");
    return true;
  });
});

test("signEvent() forwards keyId and the full event (including pubkey) to the SDK, unverified", async () => {
  const { client, sdk } = makeClient();
  const template = {
    kind: 9,
    created_at: 1,
    tags: [["h", "general"]],
    content: "hi",
    pubkey: "ab".repeat(32),
  };
  const rawEvent = { ...template, id: "id", sig: "sig" };
  sdk.onSignEvent(async () => rawEvent);

  const result = await client.signEvent("key-1", template);

  assert.deepEqual(sdk.calls.signEvent[0], ["key-1", template]);
  // signEvent() itself does not verify — that's verify.ts's job.
  assert.deepEqual(result, rawEvent);
});

test("signEvent() rejects with a mapped SignerError when the SDK reports failure", async () => {
  const { client, sdk } = makeClient();
  sdk.onSignEvent(async () => {
    throw { code: "UNAUTHORIZED", message: "No grant for this origin." };
  });

  await assert.rejects(
    client.signEvent("key-1", {
      kind: 9,
      created_at: 1,
      tags: [],
      content: "",
      pubkey: "ab".repeat(32),
    }),
    (err) => {
      assert.ok(err instanceof SignerError);
      assert.equal(err.code, "UNAUTHORIZED");
      return true;
    },
  );
});

test("an unrecognized SDK error code maps to UNKNOWN", async () => {
  const { client, sdk } = makeClient();
  sdk.onConnect(async () => {
    throw { code: "INTERACTION_REQUIRED", message: "Needs a fresh consent." };
  });

  await assert.rejects(client.connect(), (err) => {
    assert.ok(err instanceof SignerError);
    assert.equal(err.code, "UNKNOWN");
    return true;
  });
});

test("openKeyHost() defaults to https://openkey.so with no VITE_OPENKEY_HOST configured", async () => {
  const { openKeyHost } = await import("./openkey-client.ts");
  assert.equal(openKeyHost(), "https://openkey.so");
});
