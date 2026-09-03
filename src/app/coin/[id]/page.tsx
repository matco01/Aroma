import { CoinView } from "@/components/coin-view";

/**
 * Token pages are dynamic now that they render real chain state — prices
 * move every block, so there is nothing meaningful to prerender. The `id`
 * segment is the token's contract address.
 */
export default async function CoinPage({ params }: PageProps<"/coin/[id]">) {
  const { id } = await params;
  return <CoinView address={id} />;
}
