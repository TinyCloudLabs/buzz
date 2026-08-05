/**
 * Public kind:9 channel message publishing.
 *
 * An authenticated WebSocket state machine: connect, wait for the relay's
 * NIP-42 AUTH challenge, sign and send it, wait for an *exact* `OK … true`
 * before doing anything else, only then sign and send the kind:9 message
 * (tagged `h` with the channel id), and again wait for an exact
 * `OK … true` before considering the message published.
 *
 * Signing can be slow (an OpenKey consent card can sit open for a while,
 * or the user can switch their active signer mid-flow in "Your keys").
 * A NIP-42 challenge is single-use and tied to one connection, so neither
 * case is safe to just "wait longer" on the same socket: the relay may
 * have dropped the connection, or the signature would come back from a
 * different identity than the one the challenge was issued against.  In
 * both cases this reconnects with a brand-new WebSocket — and therefore a
 * fresh challenge — and retries, up to `maxAttempts`.
 */
import { makeAuthEvent } from "nostr-tools/nip42";

import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "@/shared/lib/signers/types";

export interface ChannelMessageSigner {
  /** Identifies which signer account this is, so identity changes mid-flight can be detected. */
  accountId: string;
  signEvent(template: UnsignedNostrEvent): Promise<SignedNostrEvent>;
}

/** A minimal WebSocket surface, so tests can supply a fake without touching the network. */
export interface WebSocketLike {
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Signals that this attempt should be abandoned and retried on a fresh connection/challenge. */
export class ChannelPublishReconnectError extends Error {}

const DEFAULT_WS_FACTORY: WebSocketFactory = (url) => new WebSocket(url);
const DEFAULT_MAX_ATTEMPTS = 3;
// Generous: matches the consent window an OpenKey iframe request allows.
const ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

export interface PublishChannelMessageOptions {
  wsUrl: string;
  channelId: string;
  content: string;
  /** Read at the start of each attempt, and again after each signing step, to detect identity changes. */
  getSigner: () => ChannelMessageSigner | null;
  createWebSocket?: WebSocketFactory;
  maxAttempts?: number;
}

export async function publishChannelMessage(
  opts: PublishChannelMessageOptions,
): Promise<{ eventId: string }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const createWebSocket = opts.createWebSocket ?? DEFAULT_WS_FACTORY;

  let lastError: Error = new Error("Failed to publish channel message.");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptPublish({
        wsUrl: opts.wsUrl,
        channelId: opts.channelId,
        content: opts.content,
        getSigner: opts.getSigner,
        createWebSocket,
      });
    } catch (err) {
      if (err instanceof ChannelPublishReconnectError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

type AttemptState =
  | "awaiting-auth-challenge"
  | "signing-auth"
  | "awaiting-auth-ok"
  | "signing-message"
  | "awaiting-message-ok";

function attemptPublish(opts: {
  wsUrl: string;
  channelId: string;
  content: string;
  getSigner: () => ChannelMessageSigner | null;
  createWebSocket: WebSocketFactory;
}): Promise<{ eventId: string }> {
  return new Promise((resolve, reject) => {
    const signerAtStart = opts.getSigner();
    if (!signerAtStart) {
      reject(new Error("Choose a key before publishing a channel message."));
      return;
    }
    let state: AttemptState = "awaiting-auth-challenge";
    let authEventId: string | null = null;
    let messageEventId: string | null = null;
    let settled = false;

    const ws = opts.createWebSocket(opts.wsUrl);

    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      try {
        ws.close();
      } catch {
        // already closed
      }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Publishing the channel message timed out (state: ${state}).`,
          ),
        ),
      );
    }, ATTEMPT_TIMEOUT_MS);

    // The relay can drop an idle connection while a slow signer (e.g. an
    // OpenKey consent card) is still pending. Treat that as retryable —
    // reconnecting gets a fresh, still-valid challenge.
    const onClose = () => {
      settle(() =>
        reject(
          new ChannelPublishReconnectError(
            "Relay connection closed before the message was published.",
          ),
        ),
      );
    };
    const onError = () => {
      settle(() =>
        reject(
          new ChannelPublishReconnectError(
            "Relay connection error before the message was published.",
          ),
        ),
      );
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);

    /** True once signing settles if the active signer changed underneath us (e.g. user picked a different key in "Your keys" while a consent card was open). */
    const identityChanged = () =>
      opts.getSigner()?.accountId !== signerAtStart.accountId;

    const onMessage = (event: { data?: unknown }) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;
      const [type] = data;

      if (
        type === "AUTH" &&
        typeof data[1] === "string" &&
        state === "awaiting-auth-challenge"
      ) {
        state = "signing-auth";
        const challenge = data[1];
        const template = makeAuthEvent(
          opts.wsUrl,
          challenge,
        ) as UnsignedNostrEvent;
        signerAtStart
          .signEvent(template)
          .then((signed) => {
            if (settled) return;
            if (identityChanged()) {
              settle(() =>
                reject(
                  new ChannelPublishReconnectError(
                    "Active signer changed while authenticating.",
                  ),
                ),
              );
              return;
            }
            authEventId = signed.id;
            state = "awaiting-auth-ok";
            ws.send(JSON.stringify(["AUTH", signed]));
          })
          .catch((err) => {
            settle(() =>
              reject(
                err instanceof Error
                  ? err
                  : new Error("Failed to sign relay authentication."),
              ),
            );
          });
        return;
      }

      if (
        type === "OK" &&
        data[1] === authEventId &&
        state === "awaiting-auth-ok"
      ) {
        if (data[2] !== true) {
          // A false/stale AUTH OK during a legitimate signing flow usually
          // means the challenge went stale while we were waiting on the
          // signer, not that the identity is genuinely unauthorized —
          // retry on a fresh connection rather than failing outright.
          settle(() =>
            reject(
              new ChannelPublishReconnectError(
                typeof data[3] === "string"
                  ? data[3]
                  : "Relay authentication failed.",
              ),
            ),
          );
          return;
        }
        state = "signing-message";
        const template: UnsignedNostrEvent = {
          kind: 9,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["h", opts.channelId]],
          content: opts.content,
        };
        signerAtStart
          .signEvent(template)
          .then((signed) => {
            if (settled) return;
            if (identityChanged()) {
              settle(() =>
                reject(
                  new ChannelPublishReconnectError(
                    "Active signer changed while publishing.",
                  ),
                ),
              );
              return;
            }
            messageEventId = signed.id;
            state = "awaiting-message-ok";
            ws.send(JSON.stringify(["EVENT", signed]));
          })
          .catch((err) => {
            settle(() =>
              reject(
                err instanceof Error
                  ? err
                  : new Error("Failed to sign channel message."),
              ),
            );
          });
        return;
      }

      if (
        type === "OK" &&
        data[1] === messageEventId &&
        state === "awaiting-message-ok"
      ) {
        if (data[2] === true) {
          const publishedId = messageEventId;
          settle(() => resolve({ eventId: publishedId as string }));
        } else {
          settle(() =>
            reject(
              new Error(
                typeof data[3] === "string"
                  ? data[3]
                  : "Relay rejected the message.",
              ),
            ),
          );
        }
      }
    };

    ws.addEventListener("message", onMessage);
  });
}
