import { fallback, http, type Transport } from "viem";
import { ARC_RPC_URLS } from "./wagmi";

/**
 * A transport that survives one provider having a bad minute.
 *
 * viem's `fallback` tries each endpoint in order and moves on when one
 * errors. `rank` is deliberately off: ranking re-orders endpoints by
 * observed latency, which sounds good but means the *write* path can
 * silently migrate to whichever provider happened to be fast during a
 * sampling window. For submitting transactions, predictable ordering beats
 * marginally lower latency — you want to know which node saw your
 * transaction first.
 *
 * With a single URL configured this degrades to a plain http transport, so
 * there's no behavioural difference until a second endpoint is supplied.
 */
export function arcTransport(): Transport {
  const transports = ARC_RPC_URLS.map((url) =>
    http(url, {
      // A provider that is merely slow shouldn't stall the whole request;
      // failing over is usually quicker than waiting one out.
      timeout: 10_000,
      retryCount: 2,
      retryDelay: 250,
    }),
  );

  if (transports.length === 1) return transports[0];

  return fallback(transports, {
    rank: false,
    retryCount: 1,
  });
}
