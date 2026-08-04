import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { verifySignedEvent } from "./signers/verify";
import type { SignedNostrEvent, UnsignedNostrEvent } from "./signers/types";

export type { SignedNostrEvent, UnsignedNostrEvent } from "./signers/types";

type Nip07Provider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class Nip07UnavailableError extends Error {
  constructor() {
    super("A NIP-07 browser extension is required to join in the browser.");
    this.name = "Nip07UnavailableError";
  }
}

let ephemeralSecretKey: Uint8Array | null = null;

function getEphemeralSecretKey(): Uint8Array {
  if (!ephemeralSecretKey) {
    ephemeralSecretKey = generateSecretKey();
  }
  return ephemeralSecretKey;
}

export function hasNip07Provider(): boolean {
  return typeof window !== "undefined" && window.nostr != null;
}

/**
 * The device identity's pubkey without signing anything: the NIP-07
 * extension's pubkey when one is installed, otherwise the page-lifetime
 * ephemeral key's pubkey (created on first use).
 */
export async function getDevicePublicKey(): Promise<string> {
  const provider = typeof window === "undefined" ? undefined : window.nostr;
  if (provider) {
    return provider.getPublicKey();
  }
  return getPublicKey(getEphemeralSecretKey());
}

/**
 * Sign with NIP-07 when available, otherwise use a page-lifetime key.
 *
 * The ephemeral fallback preserves anonymous browsing on open relays. Flows
 * that create durable membership must set `requireNip07` so a reload cannot
 * orphan a relay-membership row.
 */
export async function signNostrEvent(
  template: Omit<UnsignedNostrEvent, "created_at"> & {
    created_at?: number;
  },
  options?: { requireNip07?: boolean },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  const provider = typeof window === "undefined" ? undefined : window.nostr;

  if (provider) {
    const expectedPubkey = await provider.getPublicKey();
    const signed = await provider.signEvent(unsigned);
    // A NIP-07 extension is third-party code running with page access; treat
    // its response exactly like any other untrusted signer and independently
    // recompute the id and verify the Schnorr signature rather than trusting
    // whatever fields it hands back.
    return verifySignedEvent(unsigned, signed, expectedPubkey);
  }

  if (options?.requireNip07) {
    throw new Nip07UnavailableError();
  }

  const secretKey = getEphemeralSecretKey();
  const signed = finalizeEvent(unsigned, secretKey);
  return verifySignedEvent(unsigned, signed, getPublicKey(secretKey));
}
