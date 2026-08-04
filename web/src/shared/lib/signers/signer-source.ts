/**
 * Signer-source abstraction: turns a `SignerAccount` descriptor into a
 * uniform `signEvent` call, regardless of whether the account lives on
 * "this device" (NIP-07 extension or ephemeral key) or is an OpenKey
 * public descriptor reached over the iframe contract.
 *
 * Every path here returns an event that has already passed
 * `verifySignedEvent` — callers never need to re-check a signer's output.
 */
import {
  getDevicePublicKey,
  hasNip07Provider,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";

import { OpenKeyClient } from "./openkey-client";
import type {
  SignerAccount,
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "./types";
import { verifySignedEvent } from "./verify";

export const DEVICE_ACCOUNT_ID = "device";

/** The device signer's current public descriptor (no signing, no side effects). */
export async function getDeviceAccount(): Promise<SignerAccount> {
  const pubkey = await getDevicePublicKey();
  return {
    kind: "device",
    id: DEVICE_ACCOUNT_ID,
    pubkey,
    label: hasNip07Provider()
      ? "This device (browser extension)"
      : "This device",
  };
}

/**
 * Sign a template with the given account. `created_at` is fixed by the
 * caller (not the signer) so the response can be checked against an exact,
 * pre-agreed template.
 */
export async function signWithAccount(
  account: SignerAccount,
  template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
  deps: { openkey?: OpenKeyClient } = {},
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };

  if (account.kind === "device") {
    // signNostrEvent already applies verifySignedEvent internally.
    return signNostrEvent(unsigned);
  }

  // OpenKey's sign-event API (unlike the device signer) checks the
  // template's own `pubkey` against the signing key on record, so it must
  // be included here even though the local `UnsignedNostrEvent` shape
  // otherwise omits it (the device path derives pubkey from the secret key
  // itself).
  const openkey = deps.openkey ?? new OpenKeyClient();
  const raw = await openkey.signEvent(account.id, {
    ...unsigned,
    pubkey: account.pubkey,
  });
  return verifySignedEvent(unsigned, raw, account.pubkey);
}
