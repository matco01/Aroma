import { PortfolioView } from "@/components/portfolio-view";

export const metadata = {
  title: "Portfolio",
  description: "Your holdings across every token launched on Aroma.",
};

export default function PortfolioPage() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-7">
      <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
        Portfolio
      </h1>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        Everything you hold across tokens launched on Aroma, priced in USDC.
      </p>

      <div className="mt-6">
        <PortfolioView />
      </div>
    </div>
  );
}
