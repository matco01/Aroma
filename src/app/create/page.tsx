import type { Metadata } from "next";
import Link from "next/link";
import { CreateForm } from "@/components/create-form";

export const metadata: Metadata = {
  title: "Launch a coin",
  description:
    "Deploy a fixed-supply token on Arc in one transaction, priced in USDC from the first block.",
};

/**
 * The form, and a way back to the board.
 *
 * There used to be a headline, a paragraph, and three numbered cards
 * explaining deploy / trade / graduate. All of it was written for someone
 * deciding whether to use a launchpad — but you only reach this page by
 * pressing Create, so that decision is already made. It pushed the first
 * field most of a screen down and made a two-minute task look like
 * homework.
 *
 * The mechanics that mattered are still stated, next to the field they
 * actually affect: the cost panel says what launching costs and what a
 * creator earns, and the curve panel says where it graduates.
 */
export default function CreatePage() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-5">
      <Link
        href="/"
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
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
        <CreateForm />
      </div>
    </div>
  );
}
