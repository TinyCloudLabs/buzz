import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannelPublishReconnectError,
  publishChannelMessage,
} from "./channel-client.ts";

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fake `WebSocketLike` driven entirely by the test — no real network. */
function makeFakeSocket(url) {
  const listeners = { message: [], close: [], error: [] };
  const sentFrames = [];
  let closed = false;
  return {
    url,
    sentFrames,
    get closed() {
      return closed;
    },
    addEventListener(type, fn) {
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
    close() {
      closed = true;
    },
    emitMessage(payload) {
      for (const fn of [...listeners.message])
        fn({ data: JSON.stringify(payload) });
    },
    emitClose() {
      for (const fn of [...listeners.close]) fn({});
    },
    emitError() {
      for (const fn of [...listeners.error]) fn({});
    },
  };
}

function makeFactory() {
  const sockets = [];
  const factory = (url) => {
    const socket = makeFakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  factory.sockets = sockets;
  return factory;
}

/** A fake `ChannelMessageSigner` — deterministic, no real crypto (channel-client
 * trusts its signer's output as already-verified; that boundary is verify.ts's
 * job, covered separately). */
function makeSigner(accountId) {
  let counter = 0;
  return {
    accountId,
    async signEvent(template) {
      counter += 1;
      return {
        ...template,
        id: `${accountId}-${counter}`,
        pubkey: `pk-${accountId}`,
        sig: `sig-${accountId}-${counter}`,
      };
    },
  };
}

test("publishChannelMessage completes the full AUTH -> OK -> EVENT -> OK handshake", async () => {
  const factory = makeFactory();
  const signer = makeSigner("device");

  const resultPromise = publishChannelMessage({
    wsUrl: "wss://relay.test",
    channelId: "channel-1",
    content: "hello",
    getSigner: () => signer,
    createWebSocket: factory,
  });

  await tick();
  assert.equal(factory.sockets.length, 1);
  const socket = factory.sockets[0];
  assert.equal(socket.url, "wss://relay.test");

  socket.emitMessage(["AUTH", "challenge-1"]);
  await tick();

  assert.equal(socket.sentFrames.length, 1);
  const [authType, authEvent] = socket.sentFrames[0];
  assert.equal(authType, "AUTH");
  assert.equal(authEvent.kind, 22242);
  assert.deepEqual(authEvent.tags, [
    ["relay", "wss://relay.test"],
    ["challenge", "challenge-1"],
  ]);

  socket.emitMessage(["OK", authEvent.id, true]);
  await tick();

  assert.equal(socket.sentFrames.length, 2);
  const [eventType, messageEvent] = socket.sentFrames[1];
  assert.equal(eventType, "EVENT");
  assert.equal(messageEvent.kind, 9);
  assert.deepEqual(messageEvent.tags, [["h", "channel-1"]]);
  assert.equal(messageEvent.content, "hello");

  socket.emitMessage(["OK", messageEvent.id, true]);
  const result = await resultPromise;

  assert.deepEqual(result, { eventId: messageEvent.id });
  assert.equal(socket.closed, true);
});

test("a false AUTH OK reconnects on a fresh WebSocket and fresh challenge, then succeeds", async () => {
  const factory = makeFactory();
  const signer = makeSigner("device");

  const resultPromise = publishChannelMessage({
    wsUrl: "wss://relay.test",
    channelId: "channel-1",
    content: "hi",
    getSigner: () => signer,
    createWebSocket: factory,
  });

  await tick();
  const first = factory.sockets[0];
  first.emitMessage(["AUTH", "stale-challenge"]);
  await tick();
  const [, firstAuthEvent] = first.sentFrames[0];
  first.emitMessage(["OK", firstAuthEvent.id, false, "restricted: try again"]);
  await tick();

  // Reconnected on a brand-new socket, not retried on the same one.
  assert.equal(factory.sockets.length, 2);
  assert.equal(first.closed, true);

  const second = factory.sockets[1];
  second.emitMessage(["AUTH", "fresh-challenge"]);
  await tick();
  const [, secondAuthEvent] = second.sentFrames[0];
  assert.notEqual(secondAuthEvent.id, firstAuthEvent.id);
  second.emitMessage(["OK", secondAuthEvent.id, true]);
  await tick();
  const [, messageEvent] = second.sentFrames[1];
  second.emitMessage(["OK", messageEvent.id, true]);

  const result = await resultPromise;
  assert.deepEqual(result, { eventId: messageEvent.id });
});

test("the relay closing the connection mid-signing reconnects rather than hanging", async () => {
  const factory = makeFactory();
  let releaseSign;
  const slowSigner = {
    accountId: "device",
    signEvent: (template) =>
      new Promise((resolve) => {
        releaseSign = () =>
          resolve({
            ...template,
            id: `slow-${Math.random()}`,
            pubkey: "pk-device",
            sig: "sig",
          });
      }),
  };

  const resultPromise = publishChannelMessage({
    wsUrl: "wss://relay.test",
    channelId: "channel-1",
    content: "hi",
    getSigner: () => slowSigner,
    createWebSocket: factory,
  });

  await tick();
  const first = factory.sockets[0];
  first.emitMessage(["AUTH", "challenge-1"]);
  await tick(); // AUTH signing started (call #1) and left pending

  // Relay drops the connection while the (slow, e.g. OpenKey consent) signer
  // is still pending.
  first.emitClose();
  await tick();

  assert.equal(factory.sockets.length, 2, "must reconnect on a fresh socket");
  assert.equal(
    first.sentFrames.length,
    0,
    "the abandoned attempt must never send",
  );

  // A late resolve from the abandoned first attempt must be inert.
  const staleRelease = releaseSign;
  staleRelease();
  await tick();
  assert.equal(first.sentFrames.length, 0);

  const second = factory.sockets[1];
  second.emitMessage(["AUTH", "challenge-2"]);
  await tick(); // AUTH signing started (call #2) and left pending
  releaseSign();
  await tick();
  const [, authEvent] = second.sentFrames[0];
  second.emitMessage(["OK", authEvent.id, true]);
  await tick(); // message signing started (call #3) and left pending
  releaseSign();
  await tick();
  const [, messageEvent] = second.sentFrames[1];
  second.emitMessage(["OK", messageEvent.id, true]);

  const result = await resultPromise;
  assert.deepEqual(result, { eventId: messageEvent.id });
});

test("switching the active signer mid-flight reconnects instead of publishing under the stale identity", async () => {
  const factory = makeFactory();
  let currentSigner;
  let releaseMessageSign;
  let authCallCount = 0;
  const deviceSigner = {
    accountId: "device",
    async signEvent(template) {
      authCallCount += 1;
      if (authCallCount === 1) {
        // AUTH signing resolves immediately.
        return {
          ...template,
          id: "auth-1",
          pubkey: "pk-device",
          sig: "sig-auth",
        };
      }
      // Message signing is deliberately deferred so the test can flip the
      // active signer while it's in flight — exactly the "user picked a
      // different key in Your keys while an OpenKey consent card (or this)
      // was pending" race this guards against.
      return new Promise((resolve) => {
        releaseMessageSign = () =>
          resolve({
            ...template,
            id: "msg-1",
            pubkey: "pk-device",
            sig: "sig-msg",
          });
      });
    },
  };
  currentSigner = deviceSigner;
  const openkeySigner = makeSigner("openkey-key-1");

  const resultPromise = publishChannelMessage({
    wsUrl: "wss://relay.test",
    channelId: "channel-1",
    content: "hi",
    getSigner: () => currentSigner,
    createWebSocket: factory,
  });

  await tick();
  const first = factory.sockets[0];
  first.emitMessage(["AUTH", "challenge-1"]);
  await tick();
  const [, authEvent] = first.sentFrames[0];
  first.emitMessage(["OK", authEvent.id, true]);
  await tick(); // message signing started (deferred) under the device identity

  // User picks a different key in "Your keys" while the message is signing.
  currentSigner = openkeySigner;
  releaseMessageSign();
  await tick();

  assert.equal(
    factory.sockets.length,
    2,
    "identity change must force a reconnect",
  );
  assert.equal(
    first.sentFrames.length,
    1,
    "the stale identity's message must never be sent",
  );

  const second = factory.sockets[1];
  second.emitMessage(["AUTH", "challenge-2"]);
  await tick();
  const [, secondAuthEvent] = second.sentFrames[0];
  assert.equal(secondAuthEvent.pubkey, "pk-openkey-key-1");
  second.emitMessage(["OK", secondAuthEvent.id, true]);
  await tick();
  const [, messageEvent] = second.sentFrames[1];
  assert.equal(messageEvent.pubkey, "pk-openkey-key-1");
  second.emitMessage(["OK", messageEvent.id, true]);

  const result = await resultPromise;
  assert.deepEqual(result, { eventId: messageEvent.id });
});

test("publishChannelMessage gives up after maxAttempts and surfaces the relay's reason", async () => {
  const factory = makeFactory();
  const signer = makeSigner("device");

  const resultPromise = publishChannelMessage({
    wsUrl: "wss://relay.test",
    channelId: "channel-1",
    content: "hi",
    getSigner: () => signer,
    createWebSocket: factory,
    maxAttempts: 2,
  });
  // Attach the rejection expectation immediately — the promise settles
  // synchronously-ish as the loop below drives it, and an unhandled
  // rejection in the gap would otherwise fail the test run.
  const assertion = assert.rejects(resultPromise, /still restricted/);

  for (let i = 0; i < 2; i++) {
    await tick();
    const socket = factory.sockets[i];
    socket.emitMessage(["AUTH", `challenge-${i}`]);
    await tick();
    const [, authEvent] = socket.sentFrames[0];
    socket.emitMessage(["OK", authEvent.id, false, "still restricted"]);
    await tick();
  }

  assert.equal(factory.sockets.length, 2);
  await assertion;
});

test("a non-reconnect signing failure fails immediately without retrying", async () => {
  const factory = makeFactory();
  const brokenSigner = {
    accountId: "device",
    async signEvent() {
      throw new Error("consent denied");
    },
  };

  const resultPromise = publishChannelMessage({
    wsUrl: "wss://relay.test",
    channelId: "channel-1",
    content: "hi",
    getSigner: () => brokenSigner,
    createWebSocket: factory,
    maxAttempts: 5,
  });

  await tick();
  factory.sockets[0].emitMessage(["AUTH", "challenge-1"]);

  await assert.rejects(resultPromise, /consent denied/);
  assert.equal(
    factory.sockets.length,
    1,
    "must not retry a non-reconnect error",
  );
});

test("ChannelPublishReconnectError is exported for callers that need to distinguish it", () => {
  const err = new ChannelPublishReconnectError("x");
  assert.ok(err instanceof Error);
});
