import type { Metadata } from "next";
import { AcceptOwnership } from "@/components/accept-ownership";
import { ProtocolFees } from "@/components/protocol-fees";

/**
 * An unlisted page for the one transaction that can only come from the vault's
 * nominated owner.
 *
 * Not in the nav, not in the sitemap, and `noindex` — not because anything
 * here is secret (every figure on it is public chain state, and the button is
 * useless to a wallet that is not the nominee) but because it is not content.
 * A crawler indexing it would put an admin step in search results for a
 * launchpad, which helps nobody.
 */
export const metadata: Metadata = {
  title: "Vault ownership",
  description: "Accept ownership of the Aroma pool vault.",
  robots: { index: false, follow: false },
};

export default function OwnerPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-[15px] text-ink">Vault owner</h1>
      <p className="mt-2 text-[12.5px] text-ink-3">
        The two things only the vault&apos;s owner can do. Creator fees are not here —
        those belong to whoever launched each coin, and are claimed on the coin&apos;s
        own page.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <ProtocolFees />

        <div className="rounded-md border border-line bg-surface p-3.5">
          <span className="label">Ownership</span>
          <p className="mt-2 mb-3 text-[12px] leading-relaxed text-ink-2">
            Ownership moves in two steps. The old owner nominates; the new one accepts
            from their own wallet. Until that second step lands, the old owner still
            controls fee withdrawal.
          </p>
          <AcceptOwnership />
        </div>
      </div>
    </div>
  );
}
