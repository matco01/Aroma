"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, type Address, type PublicClient } from "viem";
import { clubsDeployed } from "./arc";
import { activeChain } from "./chain";
import * as club from "./club-trade";
import { tradeError, useArcChain, useCtx, type TxPhase } from "./use-trade";

/**
 * Everything a club coin page needs about the connected wallet: whether it is
 * in, how many seats it has left, what it can claim, and the actions — make an
 * invite link, cancel outstanding ones, claim.
 *
 * Read from the vault rather than the index, for the reason use-creator-fees
 * gives: membership decides whether a buy goes through, and a balance you are
 * about to withdraw should never be a few seconds stale.
 */
export function useClub(tokenAddress: string | undefined, isClub: boolean) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: activeChain.id }) as unknown as PublicClient | undefined;
  const queryClient = useQueryClient();
  const makeCtx = useCtx();
  const ensureChain = useArcChain();

  const enabled = clubsDeployed && isClub && Boolean(tokenAddress) && Boolean(address) && Boolean(publicClient);

  const status = useQuery({
    queryKey: ["club-status", tokenAddress, address],
    queryFn: () => club.clubStatus(publicClient!, tokenAddress as Address, address as Address),
    enabled,
    refetchInterval: 15_000,
  });

  const claimable = useQuery({
    queryKey: ["club-claimable", address],
    queryFn: () => club.clubClaimable(publicClient!, address as Address),
    enabled: clubsDeployed && isClub && Boolean(address) && Boolean(publicClient),
    refetchInterval: 15_000,
  });

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["club-status"] });
    queryClient.invalidateQueries({ queryKey: ["club-claimable"] });
  }, [queryClient]);

  const run = useCallback(
    async <T,>(action: (ctx: NonNullable<ReturnType<typeof makeCtx>>) => Promise<T>) => {
      try {
        setError(null);
        await ensureChain();
        const ctx = makeCtx(setPhase);
        if (!ctx) return null;
        const result = await action(ctx);
        setPhase("success");
        refresh();
        return result;
      } catch (e) {
        setError(tradeError(e));
        setPhase("error");
        return null;
      }
    },
    [ensureChain, makeCtx, refresh],
  );

  /**
   * Signs an invite and turns it into a link to this coin's page. No
   * transaction and no gas — the signature is the invite.
   */
  const createInvite = useCallback(async () => {
    if (!tokenAddress) return null;
    const invite = await run((ctx) => club.signInvite(ctx, tokenAddress as Address));
    if (!invite) return null;
    const url = `${window.location.origin}/coin/${tokenAddress}?invite=${club.encodeInvite(invite)}`;
    setLink(url);
    return url;
  }, [tokenAddress, run]);

  const revoke = useCallback(async () => {
    if (!tokenAddress) return false;
    const done = await run((ctx) => club.revokeInvites(ctx, tokenAddress as Address));
    if (done) setLink(null);
    return Boolean(done);
  }, [tokenAddress, run]);

  const claim = useCallback(async () => Boolean(await run((ctx) => club.claimClubEarnings(ctx))), [run]);

  const claimableRaw = claimable.data ?? 0n;

  return {
    loading: status.isLoading,
    isMember: status.data?.isMember ?? false,
    inviter: status.data?.inviter,
    seatsTotal: status.data?.seatsTotal ?? 0,
    seatsLeft: status.data?.seatsLeft ?? 0,
    claimableUsd: Number(formatUnits(claimableRaw, 18)),
    claimableRaw,
    link,
    createInvite,
    revoke,
    claim,
    phase,
    error,
    reset: () => {
      setPhase("idle");
      setError(null);
    },
  };
}

/**
 * Whether an invite from a link would let `address` in, checked against the
 * vault before anyone signs anything. An empty string means it would.
 */
export function useInviteCheck(
  tokenAddress: string | undefined,
  invite: club.Invite | null,
  address: string | undefined,
) {
  const publicClient = usePublicClient({ chainId: activeChain.id }) as unknown as PublicClient | undefined;
  return useQuery({
    queryKey: ["invite-check", tokenAddress, invite?.signature, address],
    queryFn: () =>
      club.inviteProblem(
        publicClient!,
        tokenAddress as Address,
        (address ?? "0x0000000000000000000000000000000000000000") as Address,
        invite!,
      ),
    enabled: clubsDeployed && Boolean(tokenAddress) && Boolean(invite) && Boolean(publicClient),
    refetchInterval: 20_000,
  });
}
