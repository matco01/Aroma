import Link from "next/link";
import { ARC_TESTNET, ARC_TESTNET_CONTRACTS, CURVE } from "@/lib/arc";

/**
 * The docs.
 *
 * Every number on this page is imported from the same constants the
 * contracts and the UI use, never typed in. Documentation that drifts from
 * the code is worse than none — someone reads a stale fee and sizes a trade
 * against it — and the only way to stop that is to make drift impossible
 * rather than a thing to remember.
 */

const nav = [
  { id: "overview", label: "Overview" },
  { id: "launches", label: "Launches" },
  { id: "curve", label: "The curve" },
  { id: "fees", label: "Fees" },
  { id: "graduation", label: "Graduation" },
  { id: "launch-tax", label: "Launch tax" },
  { id: "risks", label: "Risks" },
  { id: "contracts", label: "Contracts" },
  { id: "network", label: "Network" },
];

export function DocsView() {
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
              Aroma is a place to launch and trade tokens on {ARC_TESTNET.name}.
              Browse the board, open a coin to see its chart and trades, and buy
              or sell straight from your wallet.
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
                to {usd(2000)}. This is public — it shows on your coin as a dev
                holding.
              </li>
              <li>
                The token deploys with a fixed supply of{" "}
                {compact(CURVE.totalSupply)} and no mint function. Nobody,
                including us, can create more of it.
              </li>
            </Ol>
            <P>
              Trading opens immediately against the bonding curve. There is no
              listing step and no approval from anyone.
            </P>
          </Section>

          <Section id="curve" title="The curve">
            <P>
              Every coin starts on a bonding curve. The price is set by a
              formula, not an order book, so there is always something to trade
              against and no one has to provide liquidity.
            </P>
            <P>
              Buying moves the price up, selling moves it down, and the amount
              it moves depends on the size of the trade against what is already
              in the curve. Early buys move it more than later ones.
            </P>
            <Facts
              rows={[
                ["Total supply", compact(CURVE.totalSupply)],
                ["Sold on the curve", compact(CURVE.curveSupply)],
                ["Held back for liquidity", compact(CURVE.lpReserveSupply)],
                ["Opening market cap", usd(4300)],
              ]}
            />
            <P>
              The {compact(CURVE.lpReserveSupply)} held back is not sold to
              anyone. It is what seeds the pool at graduation, and it is why the
              price does not jump when a coin leaves the curve.
            </P>
          </Section>

          <Section id="fees" title="Fees">
            <Facts
              rows={[
                ["Launching", "Free"],
                ["Trade fee", `${CURVE.tradeFeeBps / 100}% of every buy and sell`],
                ["To the creator", `${CURVE.creatorFeeShareBps / 100}% of that fee`],
                ["To the protocol", `${100 - CURVE.creatorFeeShareBps / 100}% of that fee`],
              ]}
            />
            <P>
              On a {usd(100)} trade the fee is {usd(1)}. The creator gets{" "}
              {usd(0.7)} and Aroma gets {usd(0.3)}. The creator&apos;s share
              accrues in the contract and they claim it whenever they want; it
              is visible on the coin&apos;s page whether you are the creator or
              not.
            </P>
            <P>
              Creator fees keep accruing after graduation, from swap fees on the
              pool.
            </P>
          </Section>

          <Section id="graduation" title="Graduation">
            <P>
              A coin graduates once {usd(CURVE.graduationTargetUsd)} has been
              raised into its curve, which is a market cap of{" "}
              {usd(CURVE.graduationMarketCapUsd)}. Anyone can trigger it — it
              does not wait on us.
            </P>
            <P>
              At that point the curve closes and the raise, together with the{" "}
              {compact(CURVE.lpReserveSupply)} that was held back, seeds a
              Uniswap v4 pool. The liquidity is locked: the contract that holds
              it has no function that can reduce a position or move one out.
            </P>
            <P>
              The pool opens at the price the curve closed at. There is no jump
              — the ratio of held-back tokens to raised USDC is chosen so the
              two prices match.
            </P>
            <Note>
              Uniswap v4 is not deployed on {ARC_TESTNET.name}. On testnet a
              graduated coin&apos;s funds are held by the locker contract and
              the pool is seeded once v4 exists. Nothing can be traded after
              graduation until then.
            </Note>
          </Section>

          <Section id="launch-tax" title="Launch tax">
            <P>
              Creators can switch on a tax that falls on whoever buys in the
              first moments. Buys in the launch second pay{" "}
              {CURVE.snipeStartBps / 100}%, decaying to nothing over{" "}
              {CURVE.snipeWindowSeconds} seconds. It makes front-running a
              launch unprofitable rather than merely rude.
            </P>
            <P>
              The creator declares their own wallets as exempt when they launch.
              That list is fixed at that moment — nobody, including them, can
              add to it afterwards.
            </P>
            <P>
              The contract caps both numbers, so this cannot be turned into a
              trap. The window can never exceed{" "}
              {CURVE.snipeWindowSeconds} seconds and the rate can never exceed{" "}
              {CURVE.snipeStartBps / 100}%, whatever a creator asks for. Three
              seconds after any launch, every buyer pays the ordinary fee and
              nothing more.
            </P>
            <P>
              The tax follows the same split as a trade fee. It is off unless a
              creator turned it on, and the coin page says which.
            </P>
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
                <B>Early buyers pay less.</B> That is how a bonding curve works,
                not a bug — but it means whoever is already in is up on you the
                moment you buy.
              </li>
            </Ul>
            <P>Nothing here is investment advice.</P>
          </Section>

          <Section id="contracts" title="Contracts">
            <P>
              All verified on Arcscan. Read them rather than taking our word for
              any of the above.
            </P>
            <Addresses
              rows={[
                ["CurveManager", ARC_TESTNET_CONTRACTS.curveManager, "Holds every curve. Buying, selling, fees, graduation."],
                ["AromaFactory", ARC_TESTNET_CONTRACTS.aromaFactory, "Deploys tokens and registers them with the curve."],
                ["LiquidityLocker", ARC_TESTNET_CONTRACTS.liquidityLocker, "Holds graduated liquidity. Cannot release it."],
              ]}
            />
            <P>
              The owner key can do exactly two things: withdraw accumulated
              protocol fees, and set the factory address once at deployment.
              There is no pause, no upgrade, and no path from the owner to a
              curve reserve or a creator&apos;s fees.
            </P>
          </Section>

          <Section id="network" title="Network">
            <Facts
              rows={[
                ["Chain", ARC_TESTNET.name],
                ["Chain ID", String(ARC_TESTNET.id)],
                ["Gas token", "USDC"],
                ["Explorer", ARC_TESTNET.explorer.replace("https://", "")],
              ]}
            />
            <P>
              Test funds come from{" "}
              <A href={ARC_TESTNET.faucet}>Circle&apos;s faucet</A>. They have no
              monetary value, and neither does anything you buy with them.
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

function Addresses({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="space-y-2">
      {rows.map(([name, addr, what]) => (
        <div key={name} className="rounded-md border border-line bg-surface px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13.5px] text-ink">{name}</span>
            <a
              href={`${ARC_TESTNET.explorer}/address/${addr}`}
              target="_blank"
              rel="noreferrer"
              className="num shrink-0 text-[11.5px] text-ink-3 transition-colors hover:text-ink-2"
            >
              Arcscan ↗
            </a>
          </div>
          <div className="num mt-1 break-all text-[11.5px] text-ink-2">{addr}</div>
          <p className="mt-1.5 text-[12.5px] text-ink-3">{what}</p>
        </div>
      ))}
    </div>
  );
}

/* Local formatters — the shared ones round for a dense board, which is the
   wrong trade in prose where an exact figure is the point. */
function usd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(2)}`;
}

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${n / 1_000_000_000}B`;
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  return String(n);
}
