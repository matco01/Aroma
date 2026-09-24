import type { Metadata } from "next";
import Link from "next/link";
import { ClubView } from "@/components/club-view";

export const metadata: Metadata = {
  title: "The Club",
  description:
    "A 24-hour auction for the exclusive right to launch the next coin, settled in USDG on Robinhood Chain.",
};

export default function ClubPage() {
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
