"use client";

import { useCallback, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import { poolVaultAbi } from "@/lib/abis";
import { POOL_CONTRACTS, poolsDeployed } from "@/lib/arc";
import { activeChain } from "@/lib/chain";
import { useBoard } from "@/lib/use-chain";
import { useArcChain } from "@/lib/use-trade";
import { readableError } from "@/lib/pool-trade";
import { usdPrecise } from "@/lib/format";
import { useWallet } from "./wallet";

/**
 * Protocol fees, per coin, with a button.
 *
 * `withdrawProtocolFees` takes a token and a destination, so there is one call
 * per coin and no way to sweep them in a single transaction — the contract
 * stores the balances in each coin's own `Launch` struct. That is fine on
 * chain and miserable by hand: it was a `cast send` per coin, typed from a
 * terminal, which is exactly the thing that stops working at twenty coins.
 *
 * So the list is built here and the sweep is a loop over it. Each withdrawal
 * is still its own transaction and the wallet still confirms each one; what
 * this removes is having to know which coins owe anything and assemble the
 * calls by hand.
 *
 * Coins with nothing owed are not shown. A list of zeroes is noise, and the
 * one number worth seeing is the total.
 */
export function ProtocolFees() {
  const vault = POOL_CONTRACTS.poolVault as Address;
  const { address, isConnected } = useAccount();
  const { connect } = useWallet();
  const ensureChain = useArcChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: activeChain.id });

  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const owner = useReadContract({
    address: vault,
    abi: poolVaultAbi,
    functionName: "owner",
    chainId: activeChain.id,
    query: { enabled: poolsDeployed },
  });

  // Every coin, not just a page of them — fees accrue on all of them, and a
  // coin nobody is looking at still earned money.
  const board = useBoard({ filter: "all", sort: "new", limit: 100, skip: 0 });
  const tokens = useMemo(
    () => (board.data?.tokens ?? []).map((t) => ({ id: t.contract as Address, ticker: t.ticker })),
    [board.data],
  );

  const fees = useReadContracts({
    contracts: tokens.map((t) => ({
      address: vault,
      abi: poolVaultAbi,
      functionName: "launches" as const,
      args: [t.id] as const,
      chainId: activeChain.id,
    })),
    query: { enabled: poolsDeployed && tokens.length > 0 },
  });

  const owed = useMemo(() => {
    const rows: { id: Address; ticker: string; amount: bigint }[] = [];
    fees.data?.forEach((r, i) => {
      if (r.status !== "success") return;
      // Launch is (creator, poolId, creatorUsdc, protocolUsdc).
      const protocolUsdc = (r.result as readonly unknown[])[3] as bigint;
      if (protocolUsdc > 0n && !done.includes(tokens[i].id)) {
        rows.push({ id: tokens[i].id, ticker: tokens[i].ticker, amount: protocolUsdc });
      }
    });
    return rows.sort((a, b) => (b.amount > a.amount ? 1 : -1));
  }, [fees.data, tokens, done]);

  const total = owed.reduce((sum, r) => sum + r.amount, 0n);
  const isOwner =
    !!address && !!owner.data && address.toLowerCase() === (owner.data as string).toLowerCase();

  const withdraw = useCallback(
    async (rows: { id: Address; ticker: string }[]) => {
      if (!address) return;
      try {
        setError(null);
        await ensureChain();
        for (const row of rows) {
          setBusy(row.id);
          const hash = await writeContractAsync({
            address: vault,
            abi: poolVaultAbi,
            functionName: "withdrawProtocolFees",
            args: [row.id, address],
            chainId: activeChain.id,
          });
          const receipt = await publicClient!.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${row.ticker} reverted.`);
          // Marked locally as well as refetched: the read is cached and would
          // otherwise show the coin as still owing for a few seconds.
          setDone((d) => [...d, row.id]);
        }
        fees.refetch();
      } catch (e) {
        setError(readableError(e));
      } finally {
        setBusy(null);
      }
    },
    [address, ensureChain, writeContractAsync, publicClient, vault, fees],
  );

  if (!poolsDeployed) return null;

  if (!isConnected) {
    return (
      <Shell>
        <p className="text-[12.5px] text-ink-2">Connect the owner wallet to withdraw.</p>
        <button type="button" onClick={connect} className={BTN}>
          Connect wallet
        </button>
      </Shell>
    );
  }

  if (owner.isPending || board.isLoading || fees.isPending) {
    return (
      <Shell>
        <p className="text-[12.5px] text-ink-3">Reading the vault…</p>
      </Shell>
    );
  }

  if (!isOwner) {
    return (
      <Shell>
        <p className="text-[12.5px] text-ink-2">
          Only the vault owner can withdraw protocol fees.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between">
        <span className="num text-[20px] text-ink">{usdPrecise(Number(formatUnits(total, 18)))}</span>
        <span className="text-[11.5px] text-ink-3">
          {owed.length === 0 ? "nothing owed" : `across ${owed.length} coin${owed.length > 1 ? "s" : ""}`}
        </span>
      </div>

      {owed.length > 0 && (
        <>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {owed.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="num text-[12.5px] text-ink-2">${r.ticker}</span>
                <span className="flex items-center gap-3">
                  <span className="num text-[12.5px] text-ink">
                    {usdPrecise(Number(formatUnits(r.amount, 18)))}
                  </span>
                  <button
                    type="button"
                    onClick={() => withdraw([r])}
                    disabled={busy !== null}
                    className={SMALL_BTN}
                  >
                    {busy === r.id ? "…" : "Withdraw"}
                  </button>
                </span>
              </li>
            ))}
          </ul>

          {owed.length > 1 && (
            <button type="button" onClick={() => withdraw(owed)} disabled={busy !== null} className={BTN}>
              {busy ? "Withdrawing…" : `Withdraw all (${owed.length} transactions)`}
            </button>
          )}
          <p className="text-[11.5px] leading-relaxed text-ink-3">
            The contract holds each coin&apos;s fees separately, so this is one transaction
            per coin. Your wallet will ask once for each.
          </p>
        </>
      )}

      {error && (
        <p className="slide-in rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
          {error}
        </p>
      )}
      {done.length > 0 && !busy && !error && (
        <p className="text-[12px] text-up">
          Withdrawn to {address?.slice(0, 6)}…{address?.slice(-4)}.
        </p>
      )}
    </Shell>
  );
}

const BTN =
  "h-9 rounded-sm bg-up px-4 text-[12.5px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3";
const SMALL_BTN =
  "h-7 rounded-sm border border-line px-2.5 text-[11.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <span className="label">Protocol fees</span>
      <div className="mt-2 flex flex-col items-start gap-3">{children}</div>
    </div>
  );
}
