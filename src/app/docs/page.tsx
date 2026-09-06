import type { Metadata } from "next";
import { DocsView } from "@/components/docs-view";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How Aroma works: the curve, fees, graduation, the launch tax, and the contracts behind them.",
};

export default function DocsPage() {
  return <DocsView />;
}
