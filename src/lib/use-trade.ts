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
import { SETTLEMENT } from "./network";
import * as pool from "./pool-trade";
import * as club from "./club-trade";

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
 * An error, in words, for either kind of coin. Club refusals — invite only, no
 * seats, expired — are checked first because pool-trade's readableError knows
 * nothing about them and would fall back to raw revert text.
 */
export function tradeError(e: unknown): string {
  const msg =
    e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e);
  return club.clubReason(msg) ?? pool.readableError(e);
}

/**
 * Makes sure the wallet is on this build's chain before it is asked to sign
 * anything.
 *
 * Nothing did this before, which was survivable while the only people using
 * the app had added a testnet on purpose. On launch day most wallets will
 * arrive on Ethereum or Base, and every first trade would have failed with a
 * chain mismatch nobody could act on. wagmi's switch also offers to add the
 * network when the wallet has never heard of it, using the RPC and explorer
 * from chain.ts.
 */
export function useActiveChain() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(async () => {
    if (chainId !== activeChain.id) {
      await switchChainAsync({ chainId: activeChain.id });
    }
  }, [chainId, switchChainAsync]);
}

/** The pieces pool-trade.ts and club-trade.ts need, built from wagmi. */
export function useCtx() {
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
    setError(tradeError(e));
    setPhase("error");
  }, []);

  // Memoised so the callbacks built on it keep their identity between renders.
  return useMemo(
    () => ({ phase, setPhase, error, setError, hash, setHash, reset, fail }),
    [phase, error, hash, reset, fail],
  );
}

/**
 * @param isClub   Which contract system the coin lives in. Decides the router,
 *                 and whether a buy needs membership.
 * @param invite   An invite from the page's link, if there is one. Only used
 *                 by a club buy, and only while the buyer is not yet a member.
 */
export function useTrade(
  tokenAddress: string | undefined,
  isClub = false,
  invite: club.Invite | null = null,
) {
  const ensureChain = useActiveChain();
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
    // club-status: joining is a buy, and the panel must stop offering "Join"
    // the moment it lands rather than on its next 15-second poll.
    const keys = [["board"], ["token"], ["portfolio"], ["club-status"], ["club-claimable"]];
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
        const token = tokenAddress as Address;
        const usdc = parseUnits(usdcAmount, SETTLEMENT.decimals);
        const { hash } = isClub
          ? await club.buy(ctx, { token, usdc, slippagePct, invite })
          : await pool.buy(ctx, { token, usdc, slippagePct });
        s.setHash(hash);
        s.setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        s.fail(e);
        return false;
      }
    },
    [tokenAddress, isClub, invite, ensureChain, makeCtx, invalidate, s],
  );

  const sell = useCallback(
    async (tokenAmount: bigint, slippagePct: number): Promise<boolean> => {
      if (!tokenAddress) return false;
      try {
        s.setError(null);
        await ensureChain();
        const ctx = makeCtx(s.setPhase);
        if (!ctx) return false;
        const params = { token: tokenAddress as Address, amount: tokenAmount, slippagePct };
        const { hash } = isClub ? await club.sell(ctx, params) : await pool.sell(ctx, params);
        s.setHash(hash);
        s.setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        s.fail(e);
        return false;
      }
    },
    [tokenAddress, isClub, ensureChain, makeCtx, invalidate, s],
  );

  return { buy, sell, phase: s.phase, error: s.error, hash: s.hash, reset: s.reset };
}

export function useCreateToken() {
  const ensureChain = useActiveChain();
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
      mode: "normal" | "club" = "normal",
    ) => {
      try {
        s.setError(null);
        await ensureChain();
        const ctx = makeCtx(s.setPhase);
        if (!ctx) return;
        const launch = {
          name,
          symbol,
          description,
          metadataUri,
          devBuy: devBuyUsdc ? parseUnits(devBuyUsdc, SETTLEMENT.decimals) : 0n,
        };
        const { hash, token } =
          mode === "club" ? await club.createClub(ctx, launch) : await pool.createToken(ctx, launch);
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
