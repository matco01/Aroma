import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubView } from "@/components/club-view";
import { ON_ROBINHOOD } from "@/lib/network";

export const metadata: Metadata = {
  title: "The Club",
  description:
    "A 24-hour auction to found the next invite-only club coin, settled in USDG on Robinhood Chain.",
};

export default function ClubPage() {
  // The auction exists on Robinhood only; on Arc, launching is the create form.
  if (!ON_ROBINHOOD) redirect("/create");
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-5">
      <Link
        href="/"
        className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink sm:h-8 sm:px-3"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
          <path
            d="M5.5 1.5 L2.5 4.5 L5.5 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Back
      </Link>

      <div className="mt-4">
        <ClubView />
      </div>
    </div>
  );
}
