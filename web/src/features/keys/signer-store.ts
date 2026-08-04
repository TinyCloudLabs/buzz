/**
 * "Your keys" persistence: which OpenKey identity (if any) this browser has
 * connected, and which signer account is currently active. Only public
 * descriptors are ever stored — `keyId`/`pubkey`/`npub` — never secret key
 * material, since OpenKey never exposes it to the page in the first place.
 */
import * as React from "react";
import { decode as decodeNip19 } from "nostr-tools/nip19";

import {
  DEVICE_ACCOUNT_ID,
  getDeviceAccount,
} from "@/shared/lib/signers/signer-source";
import { OpenKeyClient } from "@/shared/lib/signers/openkey-client";
import { SignerError } from "@/shared/lib/signers/types";
import type {
  OpenKeyIdentity,
  SignerAccount,
} from "@/shared/lib/signers/types";

const STORAGE_KEY = "buzz.signerAccounts.v1";
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

interface StoredState {
  openkey: OpenKeyIdentity | null;
  activeAccountId: string | null;
}

function readStoredState(): StoredState {
  if (typeof window === "undefined")
    return { openkey: null, activeAccountId: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { openkey: null, activeAccountId: null };
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      openkey: parsed.openkey ?? null,
      activeAccountId: parsed.activeAccountId ?? null,
    };
  } catch {
    return { openkey: null, activeAccountId: null };
  }
}

function writeStoredState(state: StoredState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * An OpenKey identity descriptor is not a signature, but it should still be
 * internally consistent before we trust and persist it: the pubkey must be
 * a valid 32-byte hex string, and the npub must decode back to that exact
 * pubkey (nostr-tools' bech32 decoder, not string comparison).
 */
function assertValidOpenKeyIdentity(identity: OpenKeyIdentity): void {
  if (!HEX_PUBKEY_RE.test(identity.pubkey)) {
    throw new SignerError(
      "OpenKey returned a malformed pubkey.",
      "INVALID_RESPONSE",
    );
  }
  let decoded: ReturnType<typeof decodeNip19>;
  try {
    decoded = decodeNip19(identity.npub);
  } catch {
    throw new SignerError(
      "OpenKey returned a malformed npub.",
      "INVALID_RESPONSE",
    );
  }
  if (decoded.type !== "npub" || decoded.data !== identity.pubkey) {
    throw new SignerError(
      "OpenKey's npub does not match its pubkey.",
      "INVALID_RESPONSE",
    );
  }
  if (!identity.keyId) {
    throw new SignerError("OpenKey returned no keyId.", "INVALID_RESPONSE");
  }
}

function openKeyIdentityToAccount(identity: OpenKeyIdentity): SignerAccount {
  return {
    kind: "openkey",
    id: identity.keyId,
    pubkey: identity.pubkey,
    npub: identity.npub,
    label: "OpenKey",
  };
}

export function useSignerAccounts() {
  const [stored, setStored] = React.useState<StoredState>(() =>
    readStoredState(),
  );
  const [deviceAccount, setDeviceAccount] =
    React.useState<SignerAccount | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    getDeviceAccount()
      .then((account) => {
        if (active) setDeviceAccount(account);
      })
      .catch(() => {
        // Device pubkey resolution failing (e.g. extension denies access)
        // just means the "This device" entry stays unresolved until retried.
      });
    return () => {
      active = false;
    };
  }, []);

  const persist = React.useCallback((next: StoredState) => {
    setStored(next);
    writeStoredState(next);
  }, []);

  const openkeyAccount = stored.openkey
    ? openKeyIdentityToAccount(stored.openkey)
    : null;

  const accounts = React.useMemo(
    () =>
      [deviceAccount, openkeyAccount].filter(
        (a): a is SignerAccount => a != null,
      ),
    [deviceAccount, openkeyAccount],
  );

  const activeAccount =
    accounts.find((a) => a.id === stored.activeAccountId) ??
    deviceAccount ??
    null;

  const selectAccount = React.useCallback(
    (accountId: string) => {
      persist({ ...stored, activeAccountId: accountId });
    },
    [persist, stored],
  );

  const connectOpenKey = React.useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const client = new OpenKeyClient();
      const identity = await client.connect();
      assertValidOpenKeyIdentity(identity);
      persist({ openkey: identity, activeAccountId: identity.keyId });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not connect an OpenKey key.",
      );
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [persist]);

  const forgetOpenKey = React.useCallback(() => {
    persist({
      openkey: null,
      activeAccountId:
        stored.activeAccountId === stored.openkey?.keyId
          ? DEVICE_ACCOUNT_ID
          : stored.activeAccountId,
    });
  }, [persist, stored]);

  return {
    deviceAccount,
    openkeyAccount,
    accounts,
    activeAccount,
    selectAccount,
    connectOpenKey,
    forgetOpenKey,
    connecting,
    error,
  };
}
