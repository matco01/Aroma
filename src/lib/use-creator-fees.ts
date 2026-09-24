"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useWriteContract,
} from "wagmi";
import { formatUnits, type Address, type PublicClient } from "viem";
import { poolVaultAbi } from "./abis";
import { POOL_CONTRACTS, poolsDeployed } from "./network";
import { activeChain } from "./chain";
import { claimCreatorFees, readableError } from "./pool-trade";
import { useActiveChain } from "./use-trade";

/**
 * A creator's unclaimed fees for one token.
 *
 * Read straight from PoolVault rather than the index. Money owed to you is
 * the one number that should never be a few seconds stale, and it is a
 * single cheap call — the indexer's job is serving the board to everyone, not
 * telling one person their balance.
 *
 * Claiming pays native USDC with a plain value transfer, so the receiving
 * wallet has to accept one. Every ordinary wallet does; a contract wallet
 * with no receive function would not, and the claim reverts rather than
 * losing anything.
 */

const VAULT = POOL_CONTRACTS.poolVault as Address;

export type ClaimPhase = "idle" | "signing" | "pending" | "success" | "error";

export function useCreatorFees(tokenAddress: string | undefined, creator: string | undefined) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const ensureChain = useActiveChain();

  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const isCreator =
    Boolean(address) &&
    Boolean(creator) &&
    address!.toLowerCase() === creator!.toLowerCase();

  const { data: launch, refetch } = useReadContract({
    address: VAULT,
    abi: poolVaultAbi,
    functionName: "launches",
    args: tokenAddress ? [tokenAddress as Address] : undefined,
    chainId: activeChain.id,
    query: { enabled: Boolean(tokenAddress) && poolsDeployed, refetchInterval: 15_000 },
  });

  // launches(token) -> (creator, poolId, creatorUsdc, protocolUsdc)
  const raw = (launch as readonly unknown[] | undefined)?.[2] as bigint | undefined;
  const accrued = raw ? Number(formatUnits(raw, 18)) : 0;

  const claim = useCallback(async (): Promise<boolean> => {
    if (!tokenAddress || !publicClient || !address) return false;
    try {
      setError(null);
      await ensureChain();
      await claimCreatorFees(
        {
          publicClient: publicClient as unknown as PublicClient,
          account: address,
          write: (args) => writeContractAsync({ ...args, chainId: activeChain.id } as never),
          sign: (args) => signTypedDataAsync(args as never),
          onPhase: (p) => {
            if (p === "signing" || p === "pending") setPhase(p);
          },
        },
        tokenAddress as Address,
      );
      setPhase("success");
      refetch();
      return true;
    } catch (e) {
      setError(readableError(e));
      setPhase("error");
      return false;
    }
  }, [tokenAddress, publicClient, address, ensureChain, writeContractAsync, signTypedDataAsync, refetch]);

  return { accrued, isCreator, claim, phase, error, refetch };
}
