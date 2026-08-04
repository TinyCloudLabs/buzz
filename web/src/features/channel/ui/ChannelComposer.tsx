import { Link } from "@tanstack/react-router";
import * as React from "react";

import { useSignerAccounts } from "@/features/keys/signer-store";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { signWithAccount } from "@/shared/lib/signers/signer-source";
import { Button } from "@/shared/ui/button";

import {
  type ChannelMessageSigner,
  publishChannelMessage,
} from "../channel-client";

type SendStatus = "idle" | "sending" | "sent" | "error";

/**
 * Minimal public channel composer: a kind:9 message tagged `h` with the
 * channel id, signed by whichever account is active in "Your keys" and
 * published through the authenticated (NIP-42) relay WebSocket in
 * `channel-client.ts`.
 */
export function ChannelComposer({ channelId }: { channelId: string }) {
  const { activeAccount } = useSignerAccounts();
  const [content, setContent] = React.useState("");
  const [status, setStatus] = React.useState<SendStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const send = React.useCallback(async () => {
    const account = activeAccount;
    const trimmed = content.trim();
    if (!account || !trimmed || status === "sending") return;

    setStatus("sending");
    setError(null);

    const signer: ChannelMessageSigner = {
      accountId: account.id,
      signEvent: (template) => signWithAccount(account, template),
    };

    try {
      await publishChannelMessage({
        wsUrl: relayWsUrl(),
        channelId,
        content: trimmed,
        getSigner: () => signer,
      });
      setStatus("sent");
      setContent("");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Could not send the message.",
      );
    }
  }, [activeAccount, channelId, content, status]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="truncate text-lg font-semibold text-black dark:text-white">
          #{channelId}
        </h1>
        <Link
          to="/keys"
          className="shrink-0 text-xs text-black/50 underline-offset-4 hover:underline dark:text-white/50"
        >
          {activeAccount
            ? `Signing as ${activeAccount.label} (${truncatePubkey(activeAccount.pubkey)})`
            : "Choose a key to sign with…"}
        </Link>
      </div>

      <div className="mt-6 flex-1" />

      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="min-h-10 flex-1 resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-black shadow-xs placeholder:text-black/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-black disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-white/40"
          placeholder="Message this channel…"
          rows={1}
          value={content}
          disabled={status === "sending"}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="submit"
          disabled={status === "sending" || !content.trim() || !activeAccount}
        >
          {status === "sending" ? "Sending…" : "Send"}
        </Button>
      </form>

      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
