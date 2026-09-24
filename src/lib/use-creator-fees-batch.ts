"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContracts,
  useSignTypedData,
  useWriteContract,
} from "wagmi";
import { formatUnits, type Address, type PublicClient } from "viem";
import { poolVaultAbi } from "./abis";
import { POOL_CONTRACTS, poolsDeployed } from "./network";
import { activeChain } from "./chain";
import { claimCreatorFees, readableError } from "./pool-trade";
import { useActiveChain } from "./use-trade";
import type { Coin } from "./mock";

/**
 * Unclaimed fees across every coin a creator launched, and a way to sweep
 * them without visiting each page.
 *
 * Balances come from one batched read rather than N. Claiming, however, is N
 * transactions: PoolVault exposes claimCreatorFees(token) and has no batch
 * entry point, so there is no way to do this in a single signature today.
 * This walks the list, and the UI says which one it is on so a queue of
 * wallet prompts doesn't look like a bug.
 */

const VAULT = POOL_CONTRACTS.poolVault as Address;

export type SweepState = {
  /** 0 when idle, otherwise the 1-based index being claimed. */
  current: number;
  total: number;
  error: string | null;
  done: number;
};

export function useCreatorFeesBatch(created: Coin[]) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const ensureChain = useActiveChain();
  const [sweep, setSweep] = useState<SweepState>({
    current: 0,
    total: 0,
    error: null,
    done: 0,
  });

  const { data, refetch } = useReadContracts({
    contracts: created.map((c) => ({
      address: VAULT,
      abi: poolVaultAbi,
      functionName: "launches",
      args: [c.contract as Address],
      chainId: activeChain.id,
    })),
    query: { enabled: created.length > 0 && poolsDeployed, refetchInterval: 15_000 },
  });

  const unclaimed = created.map((coin, i) => {
    const result = data?.[i];
    // launches(token) -> (creator, poolId, creatorUsdc, protocolUsdc)
    const raw =
      result && result.status === "success"
        ? ((result.result as unknown as readonly unknown[])[2] as bigint)
        : 0n;
    return { coin, amount: Number(formatUnits(raw, 18)) };
  });

  const total = unclaimed.reduce((sum, u) => sum + u.amount, 0);
  const claimable = unclaimed.filter((u) => u.amount > 0);

  const claimAll = useCallback(async () => {
    if (!publicClient || !address || claimable.length === 0) return;

    try {
      await ensureChain();
    } catch (e) {
      setSweep((s) => ({ ...s, current: 0, error: readableError(e) }));
      return;
    }

    setSweep({ current: 1, total: claimable.length, error: null, done: 0 });

    const ctx = {
      publicClient: publicClient as unknown as PublicClient,
      account: address,
      write: (args: Parameters<typeof writeContractAsync>[0]) =>
        writeContractAsync({ ...args, chainId: activeChain.id } as never),
      sign: (args: unknown) => signTypedDataAsync(args as never),
    };

    for (let i = 0; i < claimable.length; i++) {
      setSweep((s) => ({ ...s, current: i + 1 }));
      try {
        await claimCreatorFees(ctx as never, claimable[i].coin.contract as Address);
        setSweep((s) => ({ ...s, done: s.done + 1 }));
      } catch (e) {
        const rejected = readableError(e) === "Rejected in wallet";
        // A rejection part-way through is a decision, not a failure: keep
        // whatever already succeeded and stop asking.
        setSweep((s) => ({
          ...s,
          current: 0,
          error: rejected
            ? s.done > 0
              ? `Stopped after ${s.done} of ${claimable.length}`
              : "Rejected in wallet"
            : readableError(e),
        }));
        refetch();
        return;
      }
    }

    setSweep((s) => ({ ...s, current: 0 }));
    refetch();
  }, [claimable, publicClient, address, ensureChain, writeContractAsync, signTypedDataAsync, refetch]);

  return { unclaimed, total, claimableCount: claimable.length, claimAll, sweep, refetch };
}
