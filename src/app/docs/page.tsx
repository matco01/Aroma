import type { Metadata } from "next";
import { DocsView } from "@/components/docs-view";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How Aroma works: launching into a Uniswap v4 pool, pricing, fees, graduation, and the contracts behind them.",
};

export default function DocsPage() {
  return <DocsView />;
}
