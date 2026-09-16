import Link from "next/link";
import { NETWORK, POOL, POOL_CONTRACTS, explorerUrl } from "@/lib/arc";
import { SITE_REPO } from "@/lib/site";

/**
 * The docs.
 *
 * Every number on this page is imported from the same constants the
 * contracts and the UI use, never typed in. Documentation that drifts from
 * the code is worse than none — someone reads a stale fee and sizes a trade
 * against it — and the only way to stop that is to make drift impossible
 * rather than a thing to remember.
 *
 * Written for the pool system, which is what launches on Arc mainnet. The
 * bonding-curve contracts still exist on testnet but nothing on the site uses
 * them, so describing them here would only confuse someone reading this to
 * understand what they are about to trade.
 */

const nav = [
  { id: "overview", label: "Overview" },
  { id: "launches", label: "Launches" },
  { id: "pricing", label: "Pricing" },
  { id: "fees", label: "Fees" },
  { id: "depth", label: "Sale and reserve" },
  { id: "first-block", label: "The first block" },
  { id: "risks", label: "Risks" },
  { id: "contracts", label: "Contracts" },
  { id: "trading", label: "Trading integration" },
  { id: "indexing", label: "Indexing" },
  { id: "network", label: "Network" },
];

export function DocsView() {
  const protocolShare = 100 - POOL.creatorFeeShareBps / 100;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <div className="grid gap-8 lg:grid-cols-[180px_1fr]">
        <nav className="lg:sticky lg:top-[calc(var(--header-h)+16px)] lg:self-start">
          <ul className="space-y-0.5">
            {nav.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-sm px-2 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-[680px] pb-16">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">
            Aroma docs
          </h1>

          <Section id="overview" title="Overview">
            <P>
              Aroma is a place to launch and trade coins on {NETWORK.name}.
              Browse the board, open a coin to see its chart and trades, and buy
              or sell straight from your wallet.
            </P>
            <P>
              Every coin launches straight into its own Uniswap v4 pool. There is
              no separate curve contract and no migration later — the pool is
              the market from the first block, so the coin shows up anywhere that
              reads Uniswap, not only here.
            </P>
            <P>
              Gas on Arc is USDC. That means a price is a price — no second
              asset to convert through, and no gas token to hold separately.
              Every figure on the site is dollars.
            </P>
            <P>
              Aroma never holds your funds. Your wallet signs and submits every
              transaction, and the contracts have no function that lets us move
              a token or a balance that is not ours.
            </P>
          </Section>

          <Section id="launches" title="Launches">
            <P>
              Anyone can launch. It costs nothing but gas, and it is one
              transaction.
            </P>
            <Ol>
              <li>
                Name, ticker, and optionally a description, a picture and links.
                The picture and links are pinned to IPFS; the URI goes on-chain.
              </li>
              <li>
                Optionally buy some of your own coin in the same transaction, up
                to {dollars(POOL.maxDevBuyUsd)}. This is public — it shows on your
                coin as a dev holding — and it pays the same fee as anyone
                else&apos;s buy.
              </li>
              <li>
                The token deploys with a fixed supply of{" "}
                {compact(POOL.totalSupply)} and no mint function, and the whole
                supply goes into the pool. Nobody, including us, can create more
                of it or take it back out.
              </li>
            </Ol>
            <P>
              Trading opens in that same transaction. There is no listing step
              and no approval from anyone.
            </P>
          </Section>

          <Section id="pricing" title="Pricing">
            <P>
              The whole supply is deposited as single-sided liquidity: a range of
              prices above the opening price, funded only with the token. As
              people buy, the price walks up through that range and the pool
              collects their USDC. Nobody had to provide any USDC to start it.
            </P>
            <P>
              Within a range, a Uniswap position is a constant-product curve with
              virtual reserves — the same shape a bonding curve uses. Buying moves
              the price up, selling moves it down, and early buys move it more
              than later ones.
            </P>
            <Facts
              rows={[
                ["Total supply", compact(POOL.totalSupply)],
                ["In the sale range", compact(POOL.saleSupply)],
                ["In the reserve range", compact(POOL.reserveSupply)],
                ["Opening market cap", dollars(POOL.openingMarketCapUsd)],
                ["Where the sale range ends", dollars(POOL.graduationMarketCapUsd)],
                ["Where liquidity ends", dollars(POOL.topMarketCapUsd)],
              ]}
            />
            <P>
              The figures are not round because they are where Uniswap&apos;s
              price ticks actually land, and they are stated as they are rather
              than rounded to look tidier.
            </P>
          </Section>

          <Section id="fees" title="Fees">
            <Facts
              rows={[
                ["Launching", "Free"],
                ["Trade fee", `${POOL.tradeFeeBps / 100}% of every buy and sell`],
                ["To the creator", `${POOL.creatorFeeShareBps / 100}% of that fee`],
                ["To the protocol", `${protocolShare}% of that fee`],
              ]}
            />
            <P>
              On a {dollars(100)} trade the fee is {dollars(1)}. The creator gets{" "}
              {dollars(0.7)} and Aroma gets {dollars(0.3)}.
            </P>
            <P>
              Every fee is paid in USDC, on buys and sells alike. The pool charges
              nothing itself; a hook takes the fee from whichever side of the
              trade is USDC, so no token is ever sold to pay anyone. The fee is
              part of the pool, which means it applies to every trade whichever
              app or router sends it.
            </P>
            <P>
              The creator&apos;s share accrues in the contract and they claim it
              whenever they want. It is visible on the coin&apos;s page whether
              you are the creator or not, and it never stops accruing.
            </P>
          </Section>

          <Section id="depth" title="Sale and reserve">
            <P>
              The supply is split across two price ranges in the same pool. The
              first {compact(POOL.saleSupply)} tokens — the sale — are spread
              from the opening price up to {dollars(POOL.graduationMarketCapUsd)}
              of market cap. The remaining {compact(POOL.reserveSupply)} sit
              above that, continuing the same pool to{" "}
              {dollars(POOL.topMarketCapUsd)}.
            </P>
            <P>
              Nothing happens at the boundary. There is no migration, no new
              pool, no pause and no milestone — trading simply moves from one
              range into the next, and the only thing that changes is how deep
              the book is at that price. Other launchpads call this point
              graduation because on a bonding curve it is where the coin finally
              reaches a real exchange. Here it reached one in the block it was
              created, so the word would describe something that already
              happened.
            </P>
          </Section>

          <Section id="first-block" title="The first block">
            <P>
              Pool launches have no launch tax. A coin is tradeable the moment it
              exists, and a bot watching for new pools can buy in the very next
              transaction.
            </P>
            <P>
              The protection there is, is the creator&apos;s own first buy. It runs
              inside the launch transaction, before anyone else can see the coin,
              so a creator who wants to buy their own coin cannot be front-run
              doing it.
            </P>
            <Note>
              If you are buying a coin in the seconds after it launches, you are
              competing with bots. Check the price you are paying, not only the
              market cap on the card.
            </Note>
          </Section>

          <Section id="risks" title="Risks">
            <P>
              Coins launched here are made by anonymous third parties. They
              carry no rights, no claim on anything, and can go to zero. Most
              do.
            </P>
            <Ul>
              <li>
                <B>Names and pictures can be copied.</B> Check the contract
                address, not the name. It is on every coin page.
              </li>
              <li>
                <B>The creator can sell.</B> Their holding and their claimed
                fees are shown on the coin page. Look before you buy.
              </li>
              <li>
                <B>Transactions are irreversible.</B> Once a trade is final
                there is no undo and no support desk that can reverse it.
              </li>
              <li>
                <B>Early buyers pay less.</B> That is how the pricing works, not
                a bug — but it means whoever is already in is up on you the
                moment you buy.
              </li>
              <li>
                <B>The contracts have not been audited.</B> They are tested
                against Uniswap&apos;s own deployed code and they are public, but
                nobody independent has reviewed them.
              </li>
            </Ul>
            <P>Nothing here is investment advice.</P>
          </Section>

          <Section id="contracts" title="Contracts">
            <P>
              Three contracts, on top of Uniswap v4&apos;s own. Read them rather
              than taking our word for any of the above.
            </P>
            <Addresses
              rows={[
                ["PoolFactory", POOL_CONTRACTS.poolFactory, "Deploys a token and launches its pool in one transaction."],
                ["PoolVault", POOL_CONTRACTS.poolVault, "Creates each pool, owns every position, and is the pool's hook — the fee lives here."],
                ["AromaRouter", POOL_CONTRACTS.aromaRouter, "Buys and sells. Holds nothing between trades."],
                ["Uniswap v4 PoolManager", POOL_CONTRACTS.poolManager, "Uniswap's own singleton. Every pool lives in it."],
              ]}
            />
            <P>
              The liquidity is locked because PoolVault owns every position and
              has no function that removes liquidity — not one that is guarded,
              none at all.
            </P>
            <P>
              The owner key can do exactly two things: withdraw the protocol&apos;s
              share of fees, and set the factory address once at deployment. There
              is no pause, no upgrade, and no path from the owner to a pool&apos;s
              liquidity or a creator&apos;s fees.
            </P>
            <P>
              The whole thing is public — contracts, indexer and this site — at
              {" "}<A href={SITE_REPO}>github.com/matco01/Aroma</A>. Readable and
              auditable, though not open source: it is under the Business Source
              License, which converts to MIT in 2030 rather than permitting a
              competing deployment today.
            </P>
          </Section>

          <Section id="trading" title="Trading integration">
            <P>
              Every Aroma coin is a Uniswap v4 pool with native USDC as currency0
              and the coin as currency1, tick spacing {POOL.tickSpacing}, an LP fee
              of zero, and PoolVault as its hook. Anything that can swap a v4 pool
              can trade it, and the hook charges its fee whichever route the trade
              takes.
            </P>
            <P>
              AromaRouter is the simplest way in, because Uniswap has published no
              Universal Router for Arc. It keeps sells to one transaction with an
              EIP-2612 permit instead of Permit2.
            </P>
            <Endpoints
              rows={[
                ["buy(address token, uint256 minTokensOut) payable", "USDC is the value sent. Tokens go straight to the caller."],
                ["sell(address token, uint256 amount, uint256 minUsdcOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s)", "One transaction. The permit's spender is the router."],
              ]}
            />
            <Note>
              <B>A trade the pool cannot fill completely reverts.</B> A buy larger
              than the liquidity left, or a sell of more tokens than ever left the
              pool, fails with &quot;insufficient liquidity&quot; instead of filling
              part of it. From launch the pool can take about{" "}
              {dollars(POOL.totalRaiseUsd)} in total.
            </Note>
            <P>
              For a quote, simulate the router call itself with a minimum of zero
              and read the return value. That runs the real pool, the real fee and
              the router&apos;s own checks, which is what this site does before
              every trade.
            </P>
            <P>
              Two shapes are refused by the hook: exact-output sells (&quot;give me
              exactly N USDC&quot;) revert, because charging a fee on an exact
              output would mean handing back less than was asked for. Every
              ordinary exact-input buy and sell works.
            </P>
          </Section>

          <Section id="indexing" title="Indexing">
            <P>
              Nothing custom is needed. Watch PoolFactory for new coins and
              Uniswap&apos;s PoolManager for their trades.
            </P>
            <Endpoints
              rows={[
                ["PoolFactory · TokenCreated(address token, address creator, bytes32 poolId, string name, string symbol, string description, string metadataUri, uint256 devBuyUsdc)", "A new coin and its PoolId. token, creator and poolId are indexed."],
                ["PoolManager · Swap(bytes32 id, address sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)", "Every trade. Filter by id — PoolManager serves every v4 pool on the chain."],
                ["PoolVault · FeeTaken(address token, uint256 usdc)", "The exact fee each trade paid, in USDC."],
              ]}
            />
            <P>
              Two details trip people up. A Swap&apos;s amounts are{" "}
              <B>net of the fee on a buy and gross of it on a sell</B>, because the
              hook charges before the swap in one direction and after it in the
              other. And its <B>sender is the router</B>, not the trader — use the
              transaction sender, or AromaRouter&apos;s own Bought and Sold events,
              which name the trader.
            </P>
            <P>
              The price is tokens per USDC in the pool, so a coin getting more
              expensive moves the tick down, and the sale range ends at tick{" "}
              {POOL.tickGraduation.toLocaleString("en-US")}.
            </P>
          </Section>

          <Section id="network" title="Network">
            <Facts
              rows={[
                ["Chain", NETWORK.name],
                ["Chain ID", String(NETWORK.id)],
                ["Gas token", "USDC"],
                ["Liquidity", "Uniswap v4"],
                ...(NETWORK.explorer
                  ? ([["Explorer", NETWORK.explorer.replace("https://", "")]] as [string, string][])
                  : []),
              ]}
            />
            <P>
              Your wallet will be asked to switch to {NETWORK.name}, or to add it
              if it has never seen it, the first time you trade.
            </P>
          </Section>

          <p className="mt-12 border-t border-line pt-6 text-[12.5px] text-ink-3">
            Something wrong or unclear here?{" "}
            <A href="https://x.com/Aromadotmoney">Tell us</A>.{" "}
            <Link href="/" className="text-ink-2 underline-offset-2 hover:text-ink hover:underline">
              Back to the board
            </Link>
            .
          </p>
        </article>
      </div>
    </div>
  );
}

/* ---------- small pieces, kept dumb ---------- */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-[calc(var(--header-h)+24px)]">
      <h2 className="text-[18px] font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[14px] leading-[1.65] text-ink-2">{children}</p>
);

const B = ({ children }: { children: React.ReactNode }) => (
  <span className="text-ink">{children}</span>
);

const Ul = ({ children }: { children: React.ReactNode }) => (
  <ul className="space-y-2 text-[14px] leading-[1.65] text-ink-2">{children}</ul>
);

const Ol = ({ children }: { children: React.ReactNode }) => (
  <ol className="list-decimal space-y-2 pl-5 text-[14px] leading-[1.65] text-ink-2 marker:text-ink-3">
    {children}
  </ol>
);

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-sm border border-warn/25 bg-warn/8 px-3.5 py-3 text-[13px] leading-relaxed text-warn">
      {children}
    </p>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-ink underline decoration-line-strong underline-offset-2 transition-colors hover:decoration-ink-2"
    >
      {children}
    </a>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="rounded-md border border-line bg-surface">
      {rows.map(([k, v], i) => (
        <div
          key={k}
          className={`flex items-baseline justify-between gap-4 px-3.5 py-2.5 ${
            i > 0 ? "border-t border-line" : ""
          }`}
        >
          <dt className="text-[13px] text-ink-2">{k}</dt>
          <dd className="num shrink-0 text-[13px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Endpoints({ rows }: { rows: [string, string][] }) {
  return (
    <ul className="rounded-md border border-line bg-surface">
      {rows.map(([path, what], i) => (
        <li
          key={path}
          className={`px-3.5 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}
        >
          <code className="num block break-all text-[12.5px] text-ink">{path}</code>
          <span className="mt-0.5 block text-[12.5px] text-ink-3">{what}</span>
        </li>
      ))}
    </ul>
  );
}

function Addresses({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="space-y-2">
      {rows.map(([name, addr, what]) => {
        // An empty address means not deployed yet. Saying so beats rendering
        // an empty line that looks like a missing value.
        const href = addr ? explorerUrl(`/address/${addr}`) : null;
        return (
          <div key={name} className="rounded-md border border-line bg-surface px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] text-ink">{name}</span>
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="num shrink-0 text-[11.5px] text-ink-3 transition-colors hover:text-ink-2"
                >
                  Arcscan ↗
                </a>
              )}
            </div>
            <div className="num mt-1 break-all text-[11.5px] text-ink-2">
              {addr || "Published at launch"}
            </div>
            <p className="mt-1.5 text-[12.5px] text-ink-3">{what}</p>
          </div>
        );
      })}
    </div>
  );
}

/* Local formatters — the shared ones round for a dense board, which is the
   wrong trade in prose where an exact figure is the point. */
function dollars(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${n / 1_000_000_000}B`;
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  return String(n);
}
