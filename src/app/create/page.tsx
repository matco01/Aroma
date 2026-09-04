import type { Metadata } from "next";
import { CreateForm } from "@/components/create-form";
import { CURVE } from "@/lib/arc";
import { compact, usd } from "@/lib/format";

export const metadata: Metadata = {
  title: "Launch a coin",
  description:
    "Deploy a fixed-supply token on Arc in one transaction, priced in USDC from the first block.",
};

export default function CreatePage() {
  return (
    <div className="mx-auto max-w-[940px] px-4 py-7">
      <div className="max-w-2xl">
        <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
          Launch a coin
        </h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          One transaction deploys a {compact(CURVE.totalSupply)}-supply token
          and opens its bonding curve. Free to launch — you pay Arc network
          gas and nothing else, in USDC, so there is nothing to swap for first.
        </p>
      </div>

      {/* Three-step explainer, because the mechanics are the product and
          hiding them behind a docs link is how launchpads lose trust. */}
      <ol className="mt-5 grid gap-3 sm:grid-cols-3">
        <Step
          n={1}
          title="Deploy"
          body={`Fixed supply, no mint function, no owner keys. Final in under a second.`}
        />
        <Step
          n={2}
          title="Trade on the curve"
          body={`Anyone can buy. Price rises along a public curve as USDC flows in.`}
        />
        <Step
          n={3}
          title="Graduate"
          body={`At a ${usd(CURVE.graduationMarketCapUsd)} market cap, liquidity moves to a permanently locked pool.`}
        />
      </ol>

      <div className="mt-7">
        <CreateForm />
      </div>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="rounded-md border border-line bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <span className="num flex h-4 w-4 items-center justify-center rounded-xs bg-surface-3 text-[10px] text-ink-2">
          {n}
        </span>
        <span className="text-[12.5px] font-medium text-ink">{title}</span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-2">{body}</p>
    </li>
  );
}
