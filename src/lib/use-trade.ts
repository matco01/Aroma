"use client";

import { useCallback, useState } from "react";
import { useAccount, useSignTypedData, useWriteContract, usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, type Address } from "viem";
import { curveManagerAbi, aromaTokenAbi, aromaFactoryAbi } from "./abis";
import { ARC_TESTNET_CONTRACTS, CURVE as CURVE_CONFIG } from "./arc";

/**
 * The write side: buys, sells and launches as real transactions.
 *
 * Slippage is enforced on-chain, not just displayed — every call passes a
 * minimum-out derived from a fresh quote, so a trade that moves against the
 * user between quote and inclusion reverts instead of filling badly.
 *
 * Sells sign an EIP-2612 permit rather than sending a separate approve, so
 * a sell is one wallet interaction, matching the single-transaction buy
 * that Arc's native USDC already allows.
 */

export type TxPhase = "idle" | "quoting" | "signing" | "pending" | "success" | "error";

export type TradeResult = {
  phase: TxPhase;
  error: string | null;
  hash: `0x${string}` | null;
  reset: () => void;
};

const CURVE = ARC_TESTNET_CONTRACTS.curveManager as Address;
const FACTORY = ARC_TESTNET_CONTRACTS.aromaFactory as Address;

/** Human error out of a wallet/RPC rejection, rather than a wall of hex. */
function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied transaction|rejected the request/i.test(msg)) {
    return "Rejected in wallet";
  }
  if (/slippage/i.test(msg)) return "Price moved — try again";
  if (/insufficient funds/i.test(msg)) return "Not enough USDC for this trade plus gas";
  if (/exceeds curve supply/i.test(msg)) return "Not enough left on the curve";
  if (/amount too small/i.test(msg)) return "Amount too small to trade";
  // Contract revert strings arrive wrapped; surface just the reason.
  const revert = /reverted with reason string '([^']+)'/.exec(msg);
  if (revert) return revert[1];
  return msg.split("\n")[0].slice(0, 140);
}

export function useTrade(tokenAddress: string | undefined) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setHash(null);
  }, []);

  /**
   * Refresh everything a trade touches.
   *
   * Keys must match the queries that actually exist — these said "tokens"
   * and "trades" long after the board moved to "board" and "portfolio",
   * so a trade quietly refreshed nothing but the coin page.
   *
   * Fired twice: once immediately, and again after a short delay. The
   * transaction is mined by the time we get here, but the indexer may be a
   * second behind it, and the API caches for five. Without the second pass
   * a trader sees their own trade missing from the list they just moved.
   */
  const invalidate = useCallback(() => {
    const keys = [["board"], ["token"], ["portfolio"]];
    const sweep = () => {
      for (const queryKey of keys) queryClient.invalidateQueries({ queryKey });
    };
    sweep();
    setTimeout(sweep, 3_500);
  }, [queryClient]);

  const buy = useCallback(
    async (usdcAmount: string, slippagePct: number): Promise<boolean> => {
      if (!address || !publicClient || !tokenAddress) return false;
      try {
        setError(null);
        setPhase("quoting");
        const value = parseUnits(usdcAmount, 18);

        // Quote first so the on-chain minimum reflects live curve state,
        // not a stale client-side estimate.
        const [tokensOut] = (await publicClient.readContract({
          address: CURVE,
          abi: curveManagerAbi,
          functionName: "quoteBuy",
          args: [tokenAddress as Address, value],
        })) as [bigint, bigint];

        const minOut =
          (tokensOut * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

        setPhase("signing");
        const txHash = await writeContractAsync({
          address: CURVE,
          abi: curveManagerAbi,
          functionName: "buy",
          args: [tokenAddress as Address, address, minOut],
          value,
        });

        setHash(txHash);
        setPhase("pending");
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
        return false;
      }
    },
    [address, publicClient, tokenAddress, writeContractAsync, invalidate],
  );

  const sell = useCallback(
    async (tokenAmount: bigint, slippagePct: number): Promise<boolean> => {
      if (!address || !publicClient || !tokenAddress) return false;
      try {
        setError(null);
        setPhase("quoting");

        const [usdcOut] = (await publicClient.readContract({
          address: CURVE,
          abi: curveManagerAbi,
          functionName: "quoteSell",
          args: [tokenAddress as Address, tokenAmount],
        })) as [bigint, bigint];

        const minOut = (usdcOut * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;

        const [name, nonce] = await Promise.all([
          publicClient.readContract({
            address: tokenAddress as Address,
            abi: aromaTokenAbi,
            functionName: "name",
          }) as Promise<string>,
          publicClient.readContract({
            address: tokenAddress as Address,
            abi: aromaTokenAbi,
            functionName: "nonces",
            args: [address],
          }) as Promise<bigint>,
        ]);

        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

        setPhase("signing");
        // EIP-2612: sign the approval instead of spending a transaction on
        // it, so selling is one wallet action.
        const signature = await signTypedDataAsync({
          domain: {
            name,
            version: "1",
            chainId: publicClient.chain.id,
            verifyingContract: tokenAddress as Address,
          },
          types: {
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          primaryType: "Permit",
          message: {
            owner: address,
            spender: CURVE,
            value: tokenAmount,
            nonce,
            deadline,
          },
        });

        const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
        const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
        const v = parseInt(signature.slice(130, 132), 16);

        const txHash = await writeContractAsync({
          address: CURVE,
          abi: curveManagerAbi,
          functionName: "sell",
          args: [tokenAddress as Address, tokenAmount, minOut, deadline, v, r, s],
        });

        setHash(txHash);
        setPhase("pending");
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
        return false;
      }
    },
    [address, publicClient, tokenAddress, writeContractAsync, signTypedDataAsync, invalidate],
  );

  return { buy, sell, phase, error, hash, reset };
}

export function useCreateToken() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [tokenAddress, setTokenAddress] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setHash(null);
    setTokenAddress(null);
  }, []);

  const create = useCallback(
    async (
      name: string,
      symbol: string,
      description: string,
      devBuyUsdc: string,
      metadataUri = "",
      /**
       * Launch-window tax. Off unless the creator turned it on, because a
       * tax nobody asked for is a worse default than none.
       */
      snipeGuard: { enabled: boolean; exemptWallets: string[] } = {
        enabled: false,
        exemptWallets: [],
      },
    ) => {
      if (!address || !publicClient) return;
      try {
        setError(null);
        setPhase("signing");
        const devBuy = devBuyUsdc ? parseUnits(devBuyUsdc, 18) : 0n;

        const txHash = await writeContractAsync({
          address: FACTORY,
          abi: aromaFactoryAbi,
          functionName: "createToken",
          args: [
            name,
            symbol,
            description,
            metadataUri,
            devBuy,
            0n,
            {
              // The contract caps both of these; passing the maximum is
              // the whole feature, so there is nothing to configure.
              windowSeconds: snipeGuard.enabled ? CURVE_CONFIG.snipeWindowSeconds : 0,
              startBps: snipeGuard.enabled ? CURVE_CONFIG.snipeStartBps : 0,
              exemptWallets: snipeGuard.enabled
                ? (snipeGuard.exemptWallets as Address[])
                : [],
            },
          ],
          value: devBuy,
        });

        setHash(txHash);
        setPhase("pending");
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

        // The new token's address comes back as the first indexed topic of
        // the factory's TokenCreated log.
        const log = receipt.logs.find(
          (l) => l.address.toLowerCase() === FACTORY.toLowerCase() && l.topics.length >= 2,
        );
        if (log?.topics[1]) {
          setTokenAddress(`0x${log.topics[1].slice(26)}`);
        }

        setPhase("success");
        queryClient.invalidateQueries({ queryKey: ["board"] });
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
      }
    },
    [address, publicClient, writeContractAsync, queryClient],
  );

  return { create, phase, error, hash, tokenAddress, reset };
}
