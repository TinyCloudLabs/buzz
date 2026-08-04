import { KeyRound, Laptop2 } from "lucide-react";
import type { ReactNode } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";

import { useSignerAccounts } from "../signer-store";
import type { SignerAccount } from "@/shared/lib/signers/types";

function SignerAccountRow({
  account,
  active,
  onSelect,
  icon,
  description,
}: {
  account: SignerAccount;
  active: boolean;
  onSelect: () => void;
  icon: ReactNode;
  description: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-lg border border-black/10 bg-white p-4 text-left transition-colors hover:border-black/30 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/30 data-[active=true]:border-black data-[active=true]:ring-1 data-[active=true]:ring-black dark:data-[active=true]:border-white dark:data-[active=true]:ring-white"
      data-active={active}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/5 text-black dark:bg-white/10 dark:text-white">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-black dark:text-white">
            {account.label}
          </span>
          {active ? <Badge variant="default">Active</Badge> : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-black/50 dark:text-white/50">
          {truncatePubkey(account.pubkey)}
        </p>
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          {description}
        </p>
      </div>
    </button>
  );
}

/**
 * "Your keys" — pick which signer source signs outgoing events: the device
 * identity (NIP-07 extension, or a page-lifetime key), or an OpenKey
 * passkey-backed identity. There is deliberately no export/backup action
 * for OpenKey keys here — OpenKey key material never reaches the browser,
 * so there is nothing here to export.
 */
export function KeysPage() {
  const {
    deviceAccount,
    openkeyAccount,
    activeAccount,
    selectAccount,
    connectOpenKey,
    connecting,
    error,
  } = useSignerAccounts();

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-black dark:text-white">
        <KeyRound className="h-4 w-4" /> Your keys
      </h1>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Choose which key signs the events you send from this browser.
      </p>

      <div className="mt-6 space-y-3">
        {deviceAccount ? (
          <SignerAccountRow
            account={deviceAccount}
            active={activeAccount?.id === deviceAccount.id}
            onSelect={() => selectAccount(deviceAccount.id)}
            icon={<Laptop2 className="h-4 w-4" />}
            description="A browser extension or a temporary key for this tab."
          />
        ) : (
          <div className="rounded-lg border border-black/10 bg-white p-4 text-sm text-black/50 dark:border-white/10 dark:bg-white/5 dark:text-white/50">
            Resolving this device's key…
          </div>
        )}

        {openkeyAccount ? (
          <SignerAccountRow
            account={openkeyAccount}
            active={activeAccount?.id === openkeyAccount.id}
            onSelect={() => selectAccount(openkeyAccount.id)}
            icon={<KeyRound className="h-4 w-4" />}
            description="Passkey-backed key custodied by OpenKey."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">OpenKey</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-black/60 dark:text-white/60">
                Connect a passkey-backed OpenKey key to sign as an identity that
                isn't tied to this browser.
              </p>
              <Button
                className="mt-3"
                disabled={connecting}
                onClick={() => {
                  connectOpenKey().catch(() => {
                    // Surfaced via `error` below.
                  });
                }}
              >
                {connecting ? "Connecting…" : "Connect OpenKey key"}
              </Button>
              {error ? (
                <p className="mt-2 text-sm text-red-700" role="alert">
                  {error}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
