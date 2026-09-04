"use client";

import { useCallback, useState } from "react";
import { useReadContracts, useWriteContract, usePublicClient } from "wagmi";
import { formatUnits, type Address } from "viem";
import { curveManagerAbi } from "./abis";
import { ARC_TESTNET_CONTRACTS } from "./arc";
import type { Coin } from "./mock";

/**
 * Unclaimed fees across every coin a creator launched, and a way to sweep
 * them without visiting each page.
 *
 * Balances come from one multicall rather than N reads. Claiming, however,
 * is N transactions: CurveManager exposes claimCreatorFees(token) and has
 * no batch entry point, so there is no way to do this in a single
 * signature today. A claimCreatorFeesMany(address[]) would fix that and is
 * worth adding to the next contract deployment — until then this walks the
 * list, and the UI says which one it is on so a queue of wallet prompts
 * doesn't look like a bug.
 */

const CURVE = ARC_TESTNET_CONTRACTS.curveManager as Address;

export type SweepState = {
  /** 0 when idle, otherwise the 1-based index being claimed. */
  current: number;
  total: number;
  error: string | null;
  done: number;
};

export function useCreatorFeesBatch(created: Coin[]) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [sweep, setSweep] = useState<SweepState>({
    current: 0,
    total: 0,
    error: null,
    done: 0,
  });

  const { data, refetch } = useReadContracts({
    contracts: created.map((c) => ({
      address: CURVE,
      abi: curveManagerAbi,
      functionName: "creatorFeesAccrued",
      args: [c.contract as Address],
    })),
    query: { enabled: created.length > 0, refetchInterval: 15_000 },
  });

  const unclaimed = created.map((coin, i) => {
    const result = data?.[i];
    const raw =
      result && result.status === "success" ? (result.result as bigint) : 0n;
    return { coin, amount: Number(formatUnits(raw, 18)) };
  });

  const total = unclaimed.reduce((sum, u) => sum + u.amount, 0);
  const claimable = unclaimed.filter((u) => u.amount > 0);

  const claimAll = useCallback(async () => {
    if (!publicClient || claimable.length === 0) return;

    setSweep({ current: 1, total: claimable.length, error: null, done: 0 });

    for (let i = 0; i < claimable.length; i++) {
      setSweep((s) => ({ ...s, current: i + 1 }));
      try {
        const hash = await writeContractAsync({
          address: CURVE,
          abi: curveManagerAbi,
          functionName: "claimCreatorFees",
          args: [claimable[i].coin.contract as Address],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        setSweep((s) => ({ ...s, done: s.done + 1 }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rejected = /user rejected|denied/i.test(msg);
        // A rejection part-way through is a decision, not a failure: keep
        // whatever already succeeded and stop asking.
        setSweep((s) => ({
          ...s,
          current: 0,
          error: rejected
            ? s.done > 0
              ? `Stopped after ${s.done} of ${claimable.length}`
              : "Rejected in wallet"
            : msg.split("\n")[0].slice(0, 120),
        }));
        refetch();
        return;
      }
    }

    setSweep((s) => ({ ...s, current: 0 }));
    refetch();
  }, [claimable, publicClient, writeContractAsync, refetch]);

  return { unclaimed, total, claimableCount: claimable.length, claimAll, sweep, refetch };
}
