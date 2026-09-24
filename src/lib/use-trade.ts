"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, type Address, type PublicClient } from "viem";
import { activeChain } from "./chain";
import * as pool from "./pool-trade";

/**
 * The write side: buys, sells and launches as real transactions, through the
 * pool system.
 *
 * The logic lives in pool-trade.ts as plain functions; these hooks only hold
 * the component state around them and hand them wagmi's client and signer.
 *
 * Slippage is enforced on-chain, not just displayed — every call passes a
 * minimum-out taken from simulating that exact call, so a trade that moves
 * against the user between quote and inclusion reverts instead of filling
 * badly. Sells sign an EIP-2612 permit rather than sending a separate
 * approve, so a sell is one transaction, matching the approval-free buy that
 * native USDC already allows.
 */

export type { TxPhase } from "./pool-trade";

/**
 * Makes sure the wallet is on Arc before it is asked to sign anything.
 *
 * Nothing did this before, which was survivable while the only people using
 * the app had added a testnet on purpose. On launch day most wallets will
 * arrive on Ethereum or Base, and every first trade would have failed with a
 * chain mismatch nobody could act on. wagmi's switch also offers to add the
 * network when the wallet has never heard of it, using the RPC and explorer
 * from chain.ts.
 */
export function useArcChain() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(async () => {
    if (chainId !== activeChain.id) {
      await switchChainAsync({ chainId: activeChain.id });
    }
  }, [chainId, switchChainAsync]);
}

/** The pieces pool-trade.ts needs, built from wagmi. */
function useCtx() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  return useCallback(
    (onPhase: (p: pool.TxPhase) => void): pool.Ctx | null => {
      if (!address || !publicClient) return null;
      return {
        publicClient: publicClient as unknown as PublicClient,
        account: address,
        write: (args) => writeContractAsync({ ...args, chainId: activeChain.id } as never),
        sign: (args) => signTypedDataAsync(args as never),
        onPhase,
      };
    },
    [address, publicClient, writeContractAsync, signTypedDataAsync],
  );
}

function usePhase() {
  const [phase, setPhase] = useState<pool.TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setHash(null);
  }, []);

  const fail = useCallback((e: unknown) => {
    setError(pool.readableError(e));
    setPhase("error");
  }, []);

  // Memoised so the callbacks built on it keep their identity between renders.
  return useMemo(
    () => ({ phase, setPhase, error, setError, hash, setHash, reset, fail }),
    [phase, error, hash, reset, fail],
  );
}

export function useTrade(tokenAddress: string | undefined) {
  const ensureChain = useArcChain();
  const makeCtx = useCtx();
  const queryClient = useQueryClient();
  const s = usePhase();

  /**
   * Refresh everything a trade touches.
   *
   * Fired twice: once immediately, and again after a short delay. The
   * transaction is mined by the time we get here, but the indexer may be a
   * second behind it, and the API caches for five. Without the second pass a
   * trader sees their own trade missing from the list they just moved.
   */
  const invalidate = useCallback(() => {
    const keys = [["board"], ["token"], ["portfolio"]];
    const sweep = () => {
      for (const queryKey of keys) queryClient.invalidateQueries({ queryKey });
      // wagmi's own reads — the header balance and the coin-page token
      // balance — are keyed internally, so they are refreshed by predicate.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0];
          return typeof head === "string" && (head === "balance" || head === "readContract");
        },
      });
    };
    sweep();
    setTimeout(sweep, 3_500);
  }, [queryClient]);

  const buy = useCallback(
    async (usdcAmount: string, slippagePct: number): Promise<boolean> => {
      if (!tokenAddress) return false;
      try {
        s.setError(null);
        await ensureChain();
        const ctx = makeCtx(s.setPhase);
        if (!ctx) return false;
        const { hash } = await pool.buy(ctx, {
          token: tokenAddress as Address,
          usdc: parseUnits(usdcAmount, 18),
          slippagePct,
        });
        s.setHash(hash);
        s.setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        s.fail(e);
        return false;
      }
    },
    [tokenAddress, ensureChain, makeCtx, invalidate, s],
  );

  const sell = useCallback(
    async (tokenAmount: bigint, slippagePct: number): Promise<boolean> => {
      if (!tokenAddress) return false;
      try {
        s.setError(null);
        await ensureChain();
        const ctx = makeCtx(s.setPhase);
        if (!ctx) return false;
        const { hash } = await pool.sell(ctx, {
          token: tokenAddress as Address,
          amount: tokenAmount,
          slippagePct,
        });
        s.setHash(hash);
        s.setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        s.fail(e);
        return false;
      }
    },
    [tokenAddress, ensureChain, makeCtx, invalidate, s],
  );

  return { buy, sell, phase: s.phase, error: s.error, hash: s.hash, reset: s.reset };
}

export function useCreateToken() {
  const ensureChain = useArcChain();
  const makeCtx = useCtx();
  const queryClient = useQueryClient();
  const s = usePhase();
  const [tokenAddress, setTokenAddress] = useState<string | null>(null);

  const reset = useCallback(() => {
    s.reset();
    setTokenAddress(null);
  }, [s]);

  const create = useCallback(
    async (
      name: string,
      symbol: string,
      description: string,
      devBuyUsdc: string,
      metadataUri = "",
    ) => {
      try {
        s.setError(null);
        await ensureChain();
        const ctx = makeCtx(s.setPhase);
        if (!ctx) return;
        const { hash, token } = await pool.createToken(ctx, {
          name,
          symbol,
          description,
          metadataUri,
          devBuy: devBuyUsdc ? parseUnits(devBuyUsdc, 18) : 0n,
        });
        s.setHash(hash);
        setTokenAddress(token);
        s.setPhase("success");
        queryClient.invalidateQueries({ queryKey: ["board"] });
      } catch (e) {
        s.fail(e);
      }
    },
    [ensureChain, makeCtx, queryClient, s],
  );

  return { create, phase: s.phase, error: s.error, hash: s.hash, tokenAddress, reset };
}
