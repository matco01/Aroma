"use client";

import { useCallback, useState } from "react";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { poolVaultAbi } from "@/lib/abis";
import { POOL_CONTRACTS, poolsDeployed } from "@/lib/network";
import { activeChain } from "@/lib/chain";
import { useActiveChain } from "@/lib/use-trade";
import { readableError } from "@/lib/pool-trade";
import { shortAddr } from "@/lib/format";
import { useWallet } from "./wallet";
import type { Address } from "viem";

/**
 * Hands the vault to its nominated owner.
 *
 * `transferOwnership` only nominates — Ownable2Step deliberately does not move
 * ownership until the nominee proves it can sign, which is what stops the fee
 * key being handed to an address nobody controls. So one transaction has to
 * come from the new owner, and it is `acceptOwnership()`, which takes no
 * arguments.
 *
 * That is precisely what makes it awkward away from a desk. A no-argument call
 * is a transaction carrying four bytes of calldata and no value, and most
 * mobile wallets will happily send value but offer no way to call a function.
 * The nominated owner therefore needs a button, and this is it: connect the
 * wallet the site already knows how to connect, tap once.
 *
 * It shows the vault's live ownership to anyone — that is public state and
 * worth being able to check — and shows the button only to the wallet that can
 * actually use it. Once ownership moves, `pendingOwner` becomes the zero
 * address and the button stops existing on its own.
 */
export function AcceptOwnership() {
  const vault = POOL_CONTRACTS.poolVault as Address;
  const { address, isConnected } = useAccount();
  const { connect } = useWallet();
  const ensureChain = useActiveChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: activeChain.id });

  const [phase, setPhase] = useState<"idle" | "signing" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const common = { address: vault, abi: poolVaultAbi, chainId: activeChain.id } as const;
  const owner = useReadContract({ ...common, functionName: "owner", query: { enabled: poolsDeployed } });
  const pending = useReadContract({
    ...common,
    functionName: "pendingOwner",
    query: { enabled: poolsDeployed },
  });

  const pendingOwner = pending.data as Address | undefined;

  /**
   * Three states, not two.
   *
   * An unresolved read is not the same as a read that came back zero, and
   * collapsing them is how this page first rendered "ownership is settled"
   * over a vault whose ownership was still pending — the most confident
   * possible way to be wrong. Loading and failure each say so instead.
   */
  const loading = owner.isPending || pending.isPending;
  const failed = owner.isError || pending.isError;
  const nominated =
    !!pendingOwner && pendingOwner !== "0x0000000000000000000000000000000000000000";
  const isNominee =
    nominated && !!address && address.toLowerCase() === pendingOwner.toLowerCase();

  const accept = useCallback(async () => {
    try {
      setError(null);
      await ensureChain();
      setPhase("signing");
      const hash = await writeContractAsync({
        address: vault,
        abi: poolVaultAbi,
        functionName: "acceptOwnership",
        chainId: activeChain.id,
      });
      setPhase("pending");
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted.");
      setPhase("done");
      owner.refetch();
      pending.refetch();
    } catch (e) {
      setError(readableError(e));
      setPhase("error");
    }
  }, [ensureChain, writeContractAsync, publicClient, vault, owner, pending]);

  if (!poolsDeployed) {
    return <p className="text-[12.5px] text-ink-3">No vault is deployed on this network yet.</p>;
  }

  const busy = phase === "signing" || phase === "pending";

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 text-[12.5px]">
        <Row label="Vault" value={shortAddr(vault)} title={vault} />
        <Row
          label="Owner now"
          value={owner.data ? shortAddr(owner.data as string) : "…"}
          title={(owner.data as string) ?? ""}
        />
        <Row
          label="Nominated"
          value={
            loading || failed
              ? "…"
              : nominated
                ? shortAddr(pendingOwner)
                : "nobody — ownership is settled"
          }
          title={pendingOwner ?? ""}
        />
      </dl>

      {loading ? (
        <p className="text-[12.5px] text-ink-3">Reading the vault…</p>
      ) : failed ? (
        <p className="slide-in rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
          Could not read the vault. If this build points at the wrong network, every
          read comes back empty — check NEXT_PUBLIC_ARC_RPC_URL, and remember it is
          baked in at build time.
        </p>
      ) : !nominated ? (
        <p className="text-[12.5px] text-ink-2">
          Nothing to accept. The owner above is final until someone nominates a new one.
        </p>
      ) : !isConnected ? (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-ink-2">
            Connect {shortAddr(pendingOwner)} to accept.
          </p>
          <button type="button" onClick={connect} className={"h-9 rounded-sm bg-up px-4 text-[12.5px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"}>
            Connect wallet
          </button>
        </div>
      ) : !isNominee ? (
        <p className="text-[12.5px] text-ink-2">
          This wallet is {shortAddr(address!)}. Only {shortAddr(pendingOwner)} can accept.
        </p>
      ) : phase === "done" ? (
        <p className="text-[12.5px] text-up">
          Accepted. The vault now answers to this wallet, and fee withdrawal moved with it.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={accept} disabled={busy} className={"h-9 rounded-sm bg-up px-4 text-[12.5px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"}>
            {phase === "signing"
              ? "Confirm in your wallet…"
              : phase === "pending"
                ? "Waiting for the block…"
                : "Accept ownership"}
          </button>
          {error && (
            <p className="slide-in rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="label">{label}</dt>
      <dd className="num text-ink" title={title}>
        {value}
      </dd>
    </div>
  );
}
