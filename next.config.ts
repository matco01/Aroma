import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * The clickjacking one is not theoretical here. Every destructive action in
 * this app — buy, sell, launch, claim — is a button that triggers a wallet
 * prompt, and a wallet prompt shows the transaction but not the site that
 * asked for it in any way most people read. Framed inside a hostile page
 * with an invisible overlay, "claim your airdrop" becomes a click on a
 * real Buy button. frame-ancestors is the fix, and X-Frame-Options is the
 * same instruction for anything that predates CSP.
 *
 * The CSP here deliberately stops short of script-src. A strict script
 * policy needs per-request nonces threaded through the framework's own
 * inline bootstrap, and a half-written one either breaks the app or lulls
 * you into thinking you are covered. What is here is the set that is both
 * unambiguously correct and impossible to get subtly wrong; script-src is
 * worth doing properly, as its own piece of work, and is noted in the
 * security section of the README rather than faked here.
 */
const securityHeaders = [
  // Framing. The one that actually matters for a wallet-driven UI.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },

  // Stop browsers guessing a content type. Relevant because we serve
  // JSON APIs that must never be sniffed into something executable.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Do not leak the page someone came from — on a token page the URL is
  // the contract address they are looking at, which is their business.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // We ask for none of these; say so, so an injected frame cannot either.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },

  // HSTS. Harmless over plain HTTP in local dev (browsers ignore it) and
  // correct everywhere this is actually deployed.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
