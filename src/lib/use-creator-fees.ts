"use client";

import { useCallback, useState } from "react";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { formatUnits, type Address } from "viem";
import { curveManagerAbi } from "./abis";
import { ARC_TESTNET_CONTRACTS } from "./arc";

/**
 * A creator's unclaimed fees for one token.
 *
 * Read straight from the contract rather than the index. Money owed to you
 * is the one number that should never be a few seconds stale, and
 * `creatorFeesAccrued` is a single cheap call — the indexer's job is
 * serving the board to everyone, not telling one person their balance.
 */

const CURVE = ARC_TESTNET_CONTRACTS.curveManager as Address;

export type ClaimPhase = "idle" | "signing" | "pending" | "success" | "error";

export function useCreatorFees(tokenAddress: string | undefined, creator: string | undefined) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const isCreator =
    Boolean(address) &&
    Boolean(creator) &&
    address!.toLowerCase() === creator!.toLowerCase();

  const { data: raw, refetch } = useReadContract({
    address: CURVE,
    abi: curveManagerAbi,
    functionName: "creatorFeesAccrued",
    args: tokenAddress ? [tokenAddress as Address] : undefined,
    query: { enabled: Boolean(tokenAddress), refetchInterval: 15_000 },
  });

  const accrued = raw ? Number(formatUnits(raw as bigint, 18)) : 0;

  const claim = useCallback(async (): Promise<boolean> => {
    if (!tokenAddress || !publicClient) return false;
    try {
      setError(null);
      setPhase("signing");
      const hash = await writeContractAsync({
        address: CURVE,
        abi: curveManagerAbi,
        functionName: "claimCreatorFees",
        args: [tokenAddress as Address],
      });
      setPhase("pending");
      await publicClient.waitForTransactionReceipt({ hash });
      setPhase("success");
      refetch();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /user rejected|denied/i.test(msg) ? "Rejected in wallet" : msg.split("\n")[0].slice(0, 120),
      );
      setPhase("error");
      return false;
    }
  }, [tokenAddress, publicClient, writeContractAsync, refetch]);

  return { accrued, isCreator, claim, phase, error, refetch };
}
