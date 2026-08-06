import { expect, test, type Frame, type Page } from "@playwright/test";
import { makeAuthEvent } from "nostr-tools/nip42";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  validateEvent,
  verifyEvent,
  type Event as NostrEvent,
} from "nostr-tools/pure";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BUZZ_WEB_URL = process.env.BUZZ_WEB_URL ?? "http://localhost:3000";
const OPENKEY_URL = process.env.OPENKEY_URL ?? "http://localhost:5173";
const OPENKEY_API_URL = process.env.OPENKEY_API_URL ?? "http://localhost:3001";
const RELAY_WS_URL = process.env.RELAY_WS_URL ?? "ws://localhost:3000";

const DEV_EMAIL = process.env.OPENKEY_DEV_EMAIL ?? "test@openkey.dev";
const DEV_OTP = process.env.OPENKEY_DEV_OTP ?? "000000";
const COMPOSER_PLACEHOLDER = "Message this channel…";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "harness",
  "evidence",
);
const SIGNER_STORAGE_KEY = "buzz.signerAccounts.v1";

interface EvidenceRecord {
  step: string;
  timestamp: string;
  detail: unknown;
}

interface RelayFrame {
  seq: number;
  direction: "sent" | "received";
  url: string;
  payload: string;
  parsed: unknown;
}

interface PostMessageRecord {
  direction: "sent" | "received";
  href: string;
  origin: string;
  targetOrigin?: string;
  data: unknown;
}

interface OpenKeyIdentity {
  keyId: string;
  pubkey: string;
  npub: string;
}

const evidenceLog: EvidenceRecord[] = [];
const relayFrames: RelayFrame[] = [];
const postMessages: PostMessageRecord[] = [];
let relaySeq = 0;

declare global {
  interface Window {
    __buzzOpenKeyHarnessRecordPostMessage?: (entry: unknown) => void;
  }
}

function recordEvidence(step: string, detail: unknown) {
  evidenceLog.push({ step, timestamp: new Date().toISOString(), detail });
}

function writeEvidenceFile(fileName: string, data: unknown) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, fileName),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

function parseFrame(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function installMessageInstrumentation(page: Page) {
  await page.exposeBinding(
    "__buzzOpenKeyHarnessRecordPostMessage",
    (_source, entry: PostMessageRecord) => {
      postMessages.push(entry);
    },
  );

  await page.addInitScript(() => {
    const record = (entry: unknown) => {
      try {
        window.__buzzOpenKeyHarnessRecordPostMessage?.(entry);
      } catch {
        // The test binding is best-effort instrumentation only.
      }
    };
    const original = Window.prototype.postMessage;
    Window.prototype.postMessage = function patchedPostMessage(
      message: unknown,
      targetOriginOrOptions?: string | WindowPostMessageOptions,
      transfer?: Transferable[],
    ) {
      const targetOrigin =
        typeof targetOriginOrOptions === "string"
          ? targetOriginOrOptions
          : targetOriginOrOptions?.targetOrigin;
      record({
        direction: "sent",
        href: window.location.href,
        origin: window.location.origin,
        targetOrigin,
        data: message,
      });
      return Reflect.apply(original, this, Array.from(arguments));
    };
    window.addEventListener("message", (event) => {
      record({
        direction: "received",
        href: window.location.href,
        origin: event.origin,
        data: event.data,
      });
    });
  });
}

async function installVisualViewportRegression(page: Page) {
  const buzzOrigin = new URL(BUZZ_WEB_URL).origin;
  await page.addInitScript((expectedOrigin) => {
    if (window.location.origin !== expectedOrigin) return;

    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 1024,
      height: 400,
      offsetLeft: 0,
      offsetTop: 320,
      pageLeft: 0,
      pageTop: 320,
      scale: 1,
      onresize: null,
      onscroll: null,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
  }, buzzOrigin);
}

async function expectFrameInsideVisualViewport(page: Page, frame: Frame) {
  const frameElement = await frame.frameElement();
  const box = await frameElement.boundingBox();
  expect(box).not.toBeNull();
  const cardHeight = await frameElement.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().height ?? 0,
  );

  const viewport = await page.evaluate(() => ({
    top: window.visualViewport?.offsetTop ?? 0,
    left: window.visualViewport?.offsetLeft ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  }));
  expect((box as NonNullable<typeof box>).x).toBeGreaterThanOrEqual(
    viewport.left,
  );
  expect((box as NonNullable<typeof box>).y).toBeGreaterThanOrEqual(
    viewport.top,
  );
  expect(
    (box as NonNullable<typeof box>).x + (box as NonNullable<typeof box>).width,
  ).toBeLessThanOrEqual(viewport.left + viewport.width);
  expect(
    (box as NonNullable<typeof box>).y +
      (box as NonNullable<typeof box>).height,
  ).toBeLessThanOrEqual(viewport.top + viewport.height);
  expect(cardHeight).toBeGreaterThanOrEqual(
    (box as NonNullable<typeof box>).height - 1,
  );
}

function captureRelayFrames(page: Page) {
  page.on("websocket", (ws) => {
    if (!ws.url().startsWith(RELAY_WS_URL)) return;
    ws.on("framesent", (frame) => {
      const payload = frame.payload.toString();
      relayFrames.push({
        seq: ++relaySeq,
        direction: "sent",
        url: ws.url(),
        payload,
        parsed: parseFrame(payload),
      });
    });
    ws.on("framereceived", (frame) => {
      const payload = frame.payload.toString();
      relayFrames.push({
        seq: ++relaySeq,
        direction: "received",
        url: ws.url(),
        payload,
        parsed: parseFrame(payload),
      });
    });
  });
}

function eventFromRelayFrame(frame: RelayFrame): NostrEvent | null {
  const parsed = frame.parsed;
  if (!Array.isArray(parsed)) return null;
  if ((parsed[0] !== "EVENT" && parsed[0] !== "AUTH") || !parsed[1]) {
    return null;
  }
  return parsed[1] as NostrEvent;
}

async function waitForRelayFrame(
  predicate: (frame: RelayFrame) => boolean,
  timeoutMs = 20_000,
): Promise<RelayFrame> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = relayFrames.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for relay frame");
}

function findOkFrame(eventId: string, minSeq = 0): RelayFrame | undefined {
  return relayFrames.find((frame) => {
    if (frame.seq <= minSeq || frame.direction !== "received") return false;
    const parsed = frame.parsed;
    return (
      Array.isArray(parsed) &&
      parsed[0] === "OK" &&
      parsed[1] === eventId &&
      parsed[2] === true
    );
  });
}

async function waitForOk(eventId: string, minSeq = 0): Promise<RelayFrame> {
  return waitForRelayFrame((frame) => findOkFrame(eventId, minSeq) === frame);
}

function assertSignedEvent(
  event: NostrEvent,
  expected: {
    pubkey?: string;
    kind: number;
    content: string;
    tags: string[][];
  },
) {
  const sanitized = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
  expect(validateEvent(sanitized)).toBe(true);
  expect(getEventHash(sanitized)).toBe(sanitized.id);
  expect(verifyEvent(sanitized)).toBe(true);
  if (expected.pubkey) expect(sanitized.pubkey).toBe(expected.pubkey);
  expect(sanitized.kind).toBe(expected.kind);
  expect(sanitized.content).toBe(expected.content);
  expect(sanitized.tags).toEqual(expected.tags);
  expect(
    Math.abs(Math.floor(Date.now() / 1000) - sanitized.created_at),
  ).toBeLessThan(120);
}

function signAuthEvent(sk: Uint8Array, challenge: string): NostrEvent {
  return finalizeEvent(
    makeAuthEvent(RELAY_WS_URL, challenge),
    sk,
  ) as NostrEvent;
}

async function createChannelViaProtocolEvent(): Promise<{
  channelId: string;
  event: NostrEvent;
  authAck: unknown;
  eventAck: unknown;
}> {
  const sk = generateSecretKey();
  const channelId = crypto.randomUUID();
  const channelName = `openkey-e2e-${Date.now()}`;

  const signed = finalizeEvent(
    {
      kind: 9007,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", channelId],
        ["name", channelName],
        ["visibility", "open"],
      ],
      content: "",
    },
    sk,
  ) as NostrEvent;

  const socket = new WebSocket(RELAY_WS_URL);
  await new Promise<void>((resolve) =>
    socket.addEventListener("open", () => resolve(), { once: true }),
  );
  const authAck = await authenticateNodeWs(socket, sk);
  const eventAck = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for kind-9007 OK"));
    }, 15_000);
    socket.addEventListener("message", (message) => {
      const msg = JSON.parse(String(message.data));
      if (Array.isArray(msg) && msg[0] === "OK" && msg[1] === signed.id) {
        clearTimeout(timeout);
        socket.close();
        if (msg[2] === true) resolve(msg);
        else reject(new Error(`Relay rejected setup event: ${msg[3]}`));
      }
    });
    socket.send(JSON.stringify(["EVENT", signed]));
  });
  const result = { authAck, eventAck };

  recordEvidence("channel-created", {
    channelId,
    eventId: signed.id,
    pubkey: getPublicKey(sk),
    ...result,
  });
  return { channelId, event: signed, ...result };
}

async function authenticateNodeWs(
  socket: WebSocket,
  sk: Uint8Array,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out authenticating query WS")),
      15_000,
    );
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (Array.isArray(msg) && msg[0] === "AUTH") {
        socket.send(JSON.stringify(["AUTH", signAuthEvent(sk, msg[1])]));
        return;
      }
      if (Array.isArray(msg) && msg[0] === "OK" && msg[2] === true) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Query WS error during auth"));
    });
  });
}

async function queryStoredEvent(eventId: string): Promise<NostrEvent> {
  const sk = generateSecretKey();
  const socket = new WebSocket(RELAY_WS_URL);
  await new Promise<void>((resolve) =>
    socket.addEventListener("open", () => resolve(), { once: true }),
  );
  await authenticateNodeWs(socket, sk);

  return new Promise((resolve, reject) => {
    const subId = `openkey-e2e-${Date.now()}`;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out querying stored event ${eventId}`));
    }, 15_000);

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (Array.isArray(msg) && msg[0] === "EVENT" && msg[1] === subId) {
        clearTimeout(timeout);
        socket.send(JSON.stringify(["CLOSE", subId]));
        socket.close();
        resolve(msg[2] as NostrEvent);
      }
    });
    socket.send(
      JSON.stringify(["REQ", subId, { ids: [eventId], kinds: [9], limit: 1 }]),
    );
  });
}

async function openKeyFrameWithText(
  page: Page,
  text: string,
  timeoutMs = 20_000,
): Promise<Frame> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const frame of page
      .frames()
      .filter((f) => f.url().startsWith(OPENKEY_URL))) {
      if (
        await frame
          .getByText(text, { exact: false })
          .isVisible()
          .catch(() => false)
      ) {
        return frame;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for OpenKey frame containing ${text}`);
}

async function getOpenKeyIdentity(page: Page): Promise<OpenKeyIdentity> {
  const identity = await page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw).openkey : null;
  }, SIGNER_STORAGE_KEY);
  expect(identity).toMatchObject({
    keyId: expect.any(String),
    pubkey: expect.stringMatching(/^[0-9a-f]{64}$/),
    npub: expect.stringMatching(/^npub1/),
  });
  return identity as OpenKeyIdentity;
}

async function gotoBuzzRoute(page: Page, route: string) {
  await page.goto(`${BUZZ_WEB_URL}${route}`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => new URL(page.url()).pathname).toBe(route);
}

async function connectOpenKeyIdentity(page: Page): Promise<OpenKeyIdentity> {
  await gotoBuzzRoute(page, "/keys");
  const connectButton = page.getByRole("button", {
    name: "Connect OpenKey key",
  });
  await expect(connectButton).toBeVisible({ timeout: 60_000 });
  await connectButton.click();

  let frame = await openKeyFrameWithText(page, "Continue with email");
  await expectFrameInsideVisualViewport(page, frame);
  await frame.getByRole("button", { name: "Continue with email" }).click();
  await frame.locator("#embed-email").fill(DEV_EMAIL);
  await frame.getByRole("button", { name: "Send code" }).click();
  await frame.getByPlaceholder("000000").fill(DEV_OTP);
  await frame.getByRole("button", { name: "Verify and continue" }).click();
  recordEvidence("openkey-dev-otp-complete", { email: DEV_EMAIL });

  frame = await openKeyFrameWithText(
    page,
    "Connect your OpenKey Nostr identity",
  );
  await frame.getByRole("button", { name: "Connect" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.localStorage.getItem(key),
        SIGNER_STORAGE_KEY,
      ),
    )
    .toContain("openkey");
  const identity = await getOpenKeyIdentity(page);
  recordEvidence("openkey-identity-connected", identity);
  return identity;
}

async function revokeGrantViaOpenKeyContract(page: Page, grantId: string) {
  await page.evaluate((openKeyUrl) => {
    const iframe = document.createElement("iframe");
    iframe.dataset.openkeyContractFrame = "true";
    iframe.src = `${openKeyUrl}/widget/embed/nostr/approve?origin=${encodeURIComponent(window.location.origin)}`;
    iframe.style.cssText =
      "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px";
    document.body.appendChild(iframe);
  }, OPENKEY_URL);

  const frame = await openKeyFrameWithText(page, "Connect Nostr Identity");
  const result = await frame.evaluate(
    async ({ apiUrl, id }) => {
      const token = sessionStorage.getItem("openkey_session_token");
      if (!token)
        return { ok: false, status: 0, body: "missing openkey_session_token" };
      const response = await fetch(
        `${apiUrl}/api/keys/nostr/grants/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    },
    { apiUrl: OPENKEY_API_URL, id: grantId },
  );
  await page.evaluate(() =>
    document.querySelector("[data-openkey-contract-frame]")?.remove(),
  );

  expect(result).toMatchObject({ ok: true, status: 200 });
  recordEvidence("openkey-grant-revoked", { grantId, result });
}

function nostrFlowMessagesAfter(start: number): PostMessageRecord[] {
  return postMessages.slice(start).filter((entry) => {
    const encoded = JSON.stringify(entry.data);
    return (
      encoded.includes("openkey:nostr") ||
      encoded.includes("openkey:ready") ||
      encoded.includes("openkey:close") ||
      encoded.includes("openkey:resize")
    );
  });
}

function assertVersionedNostrTransport() {
  const privileged = nostrFlowMessagesAfter(0).filter((entry) => {
    const type = (entry.data as { type?: unknown } | null)?.type;
    return typeof type === "string" && type.startsWith("openkey:nostr:");
  });
  expect(privileged.length).toBeGreaterThan(0);
  for (const entry of privileged) {
    expect(entry.data).toMatchObject({
      requestId: expect.any(String),
      protocolVersion: 1,
    });
  }
}

function assertNoSecretsOrWildcardTargetOrigins() {
  const nostrMessages = nostrFlowMessagesAfter(0);
  const encoded = JSON.stringify(nostrMessages);
  expect(encoded).not.toMatch(/nsec1/i);
  expect(encoded).not.toMatch(
    /sessionToken|session_token|openkey_session_token|Bearer\s+/i,
  );
  for (const entry of nostrMessages) {
    if (entry.direction === "sent" && entry.targetOrigin !== undefined) {
      expect(entry.targetOrigin).not.toBe("*");
    }
  }
}

async function assertBuzzStorageHasNoSecrets(page: Page) {
  const storage = await page.evaluate(() => ({
    localStorage: { ...window.localStorage },
    sessionStorage: { ...window.sessionStorage },
  }));
  const encoded = JSON.stringify(storage);
  expect(encoded).not.toMatch(/nsec1/i);
  expect(encoded).not.toMatch(
    /sessionToken|session_token|openkey_session_token|Bearer\s+|better-auth/i,
  );
  recordEvidence("buzz-storage-secret-scan", {
    storageKeys: Object.keys(storage.localStorage),
  });
}

async function publishOpenKeyMessage(
  page: Page,
  identity: OpenKeyIdentity,
  content: string,
  options: { expectKind9Consent: boolean },
): Promise<NostrEvent> {
  const startSeq = relaySeq;
  const startMessages = postMessages.length;
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
  await composer.fill(content);
  await page.getByRole("button", { name: "Send" }).click();

  const authFrame = await openKeyFrameWithText(
    page,
    "Authenticate to relay",
    7_500,
  ).catch(() => null);
  if (authFrame) {
    await authFrame.getByRole("button", { name: "Approve" }).click();
    recordEvidence("auth-consent-approved", { content });
  }

  const authSent = await waitForRelayFrame((frame) => {
    const event = eventFromRelayFrame(frame);
    return (
      frame.seq > startSeq &&
      frame.direction === "sent" &&
      Array.isArray(frame.parsed) &&
      frame.parsed[0] === "AUTH" &&
      event?.kind === 22242 &&
      event.pubkey === identity.pubkey
    );
  });
  const authEvent = eventFromRelayFrame(authSent);
  expect(authEvent).toBeTruthy();
  assertSignedEvent(authEvent as NostrEvent, {
    pubkey: identity.pubkey,
    kind: 22242,
    content: "",
    tags: (authEvent as NostrEvent).tags,
  });
  const authOk = await waitForOk((authEvent as NostrEvent).id, authSent.seq);
  recordEvidence("relay-auth-ok", {
    eventId: (authEvent as NostrEvent).id,
    ok: authOk.parsed,
  });

  if (options.expectKind9Consent) {
    const signFrame = await openKeyFrameWithText(
      page,
      "Send a channel message",
    );
    await expect(signFrame.getByText(content)).toBeVisible();
    recordEvidence("kind9-consent-visible", { content });
    await signFrame.getByRole("button", { name: "Approve" }).click();
  }

  const eventSent = await waitForRelayFrame((frame) => {
    const event = eventFromRelayFrame(frame);
    return (
      frame.seq > authOk.seq &&
      frame.direction === "sent" &&
      Array.isArray(frame.parsed) &&
      frame.parsed[0] === "EVENT" &&
      event?.kind === 9 &&
      event.content === content
    );
  });
  expect(authOk.seq).toBeLessThan(eventSent.seq);
  const event = eventFromRelayFrame(eventSent) as NostrEvent;
  assertSignedEvent(event, {
    pubkey: identity.pubkey,
    kind: 9,
    content,
    tags: [["h", new URL(page.url()).pathname.split("/").at(-1) ?? ""]],
  });
  const eventOk = await waitForOk(event.id, eventSent.seq);
  recordEvidence("relay-event-ok", { eventId: event.id, ok: eventOk.parsed });

  if (!options.expectKind9Consent) {
    const showedConsent = nostrFlowMessagesAfter(startMessages).some((entry) =>
      JSON.stringify(entry.data).includes("openkey:nostr:show"),
    );
    expect(showedConsent).toBe(false);
    recordEvidence("kind9-signing-silent", { content });
  }

  return event;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test("OpenKey Nostr signing harness against the Docker-served Buzz stack", async ({
  page,
  browser,
}) => {
  evidenceLog.length = 0;
  relayFrames.length = 0;
  postMessages.length = 0;
  relaySeq = 0;

  await installMessageInstrumentation(page);
  await installVisualViewportRegression(page);
  captureRelayFrames(page);
  page.on("pageerror", (error) => {
    recordEvidence("page-error", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      recordEvidence("browser-console-error", message.text());
    }
  });

  const grantResponses: Array<{
    id: string;
    allowedKinds: number[];
    relayUrl: string | null;
  }> = [];
  page.on("response", async (response) => {
    if (
      response.url().startsWith(`${OPENKEY_API_URL}/api/keys/nostr/`) &&
      response.url().includes("/grants") &&
      response.request().method() === "POST" &&
      response.ok()
    ) {
      const body = await response.json().catch(() => null);
      if (body?.grant) grantResponses.push(body.grant);
    }
  });

  const identity = await connectOpenKeyIdentity(page);
  await gotoBuzzRoute(page, "/keys");
  expect((await getOpenKeyIdentity(page)).pubkey).toBe(identity.pubkey);
  await page.reload({ waitUntil: "domcontentloaded" });
  expect((await getOpenKeyIdentity(page)).npub).toBe(identity.npub);

  const freshContext = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: true,
  });
  const freshPage = await freshContext.newPage();
  try {
    const freshIdentity = await connectOpenKeyIdentity(freshPage);
    expect(freshIdentity.npub).toBe(identity.npub);
    recordEvidence("openkey-identity-stable-fresh-context", {
      npub: freshIdentity.npub,
    });
  } finally {
    await freshContext.close();
  }

  const { channelId } = await createChannelViaProtocolEvent();
  await gotoBuzzRoute(page, `/channels/${channelId}`);
  await page
    .getByPlaceholder(COMPOSER_PLACEHOLDER)
    .waitFor({ state: "visible" });

  const first = await publishOpenKeyMessage(
    page,
    identity,
    `openkey e2e first ${Date.now()}`,
    {
      expectKind9Consent: true,
    },
  );
  const second = await publishOpenKeyMessage(
    page,
    identity,
    `openkey e2e second ${Date.now()}`,
    {
      expectKind9Consent: false,
    },
  );
  expect(first.pubkey).toBe(identity.pubkey);
  expect(second.pubkey).toBe(identity.pubkey);

  const queried = await queryStoredEvent(first.id);
  expect(queried.id).toBe(first.id);
  assertSignedEvent(queried, {
    pubkey: identity.pubkey,
    kind: 9,
    content: first.content,
    tags: first.tags,
  });
  recordEvidence("relay-query-returned-stored-event", { eventId: queried.id });

  const kind9Grant = grantResponses.find((grant) =>
    grant.allowedKinds.includes(9),
  );
  expect(kind9Grant).toBeTruthy();
  await revokeGrantViaOpenKeyContract(page, (kind9Grant as { id: string }).id);

  const revokeStartSeq = relaySeq;
  const revokedContent = `openkey e2e revoked ${Date.now()}`;
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(revokedContent);
  await page.getByRole("button", { name: "Send" }).click();
  const revokedFrame = await openKeyFrameWithText(
    page,
    "Send a channel message",
  );
  await expect(revokedFrame.getByText(revokedContent)).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(
    relayFrames.some((frame) => {
      const event = eventFromRelayFrame(frame);
      return (
        frame.seq > revokeStartSeq &&
        event?.kind === 9 &&
        event.content === revokedContent
      );
    }),
  ).toBe(false);
  await revokedFrame.getByRole("button", { name: "Cancel" }).click();
  recordEvidence("revoked-grant-failed-closed", { revokedContent });

  await gotoBuzzRoute(page, "/keys");
  await page.getByRole("button", { name: /This device/ }).click();
  await gotoBuzzRoute(page, `/channels/${channelId}`);
  const deviceContent = `device e2e ${Date.now()}`;
  const deviceStartSeq = relaySeq;
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(deviceContent);
  await page.getByRole("button", { name: "Send" }).click();
  const deviceEventFrame = await waitForRelayFrame((frame) => {
    const event = eventFromRelayFrame(frame);
    return (
      frame.seq > deviceStartSeq &&
      event?.kind === 9 &&
      event.content === deviceContent
    );
  });
  const deviceEvent = eventFromRelayFrame(deviceEventFrame) as NostrEvent;
  assertSignedEvent(deviceEvent, {
    kind: 9,
    content: deviceContent,
    tags: [["h", channelId]],
  });
  await waitForOk(deviceEvent.id, deviceEventFrame.seq);
  recordEvidence("device-signer-valid-event", {
    eventId: deviceEvent.id,
    pubkey: deviceEvent.pubkey,
  });

  await assertBuzzStorageHasNoSecrets(page);
  assertVersionedNostrTransport();
  assertNoSecretsOrWildcardTargetOrigins();

  writeEvidenceFile(`openkey-nostr-${Date.now()}.json`, evidenceLog);
  writeEvidenceFile(`relay-frames-${Date.now()}.json`, relayFrames);
  writeEvidenceFile(`postmessages-${Date.now()}.json`, postMessages);
});
