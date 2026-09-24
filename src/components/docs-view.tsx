import Link from "next/link";
import {
  ROBINHOOD_TESTNET,
  ROBINHOOD_TESTNET_CONTRACTS,
  CLUB,
  POOL_USDG,
} from "@/lib/robinhood";
import { SITE_REPO } from "@/lib/site";

/**
 * The docs.
 *
 * Every number on this page is imported from the same constants the
 * contracts and the UI use, never typed in. Documentation that drifts from
 * the code is worse than none — someone reads a stale fee and sizes a bid
 * against it — and the only way to stop that is to make drift impossible
 * rather than a thing to remember.
 *
 * This describes the live system: the Club auction, settled in USDG on
 * Robinhood Chain. The old permissionless, per-transaction launch flow this
 * replaced (a bonding curve, priced in native USDC on Arc) still exists in
 * the codebase, dormant, but nothing on this page is about it any more.
 */

const nav = [
  { id: "overview", label: "Overview" },
  { id: "the-club", label: "The Club" },
  { id: "fees", label: "Fees" },
  { id: "launch", label: "Launch" },
  { id: "risks", label: "Risks" },
  { id: "contracts", label: "Contracts" },
  { id: "data-api", label: "Data API" },
  { id: "trading", label: "Trading integration" },
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
              Aroma no longer lets anyone launch a coin whenever they want.
              Instead there is exactly one <B>Club</B> open at a time — a
              24-hour auction on {ROBINHOOD_TESTNET.name} for the exclusive
              right to launch the next coin. Bid, watch the countdown, and if
              you&apos;re still on top when it hits zero, your coin launches
              automatically.
            </P>
            <P>
              Everything is priced in <B>USDG</B>, a dollar-backed stablecoin
              — not the chain&apos;s own gas token, which is ETH. A bid, a
              trade and a market cap are all USDG amounts, with no volatile
              asset moving underneath them.
            </P>
            <P>
              Aroma never holds your funds. Your wallet signs and submits
              every transaction, and the contracts have no function that lets
              us move a token or a balance that isn&apos;t ours.
            </P>
          </Section>

          <Section id="the-club" title="The Club">
            <P>
              One Club is open at any moment. Bidding raises the price and
              sets the coin&apos;s draft identity — name, ticker, description,
              image and links — in the same transaction. Whoever is on top
              can keep editing that draft for free, with a separate call that
              moves no funds, right up until the countdown ends.
            </P>
            <Facts
              rows={[
                ["Round length", `${CLUB.roundDurationSeconds / 3600} hours`],
                ["Minimum opening bid", `${CLUB.minOpeningBidUsdg} USDG`],
                ["Minimum raise to outbid", `${CLUB.minBidIncrementBps / 100}%`],
                ["Anti-snipe extension", `${CLUB.antiSnipeExtensionSeconds / 60} minutes`],
              ]}
            />
            <P>
              A bid placed inside the last {CLUB.antiSnipeExtensionSeconds / 60}{" "}
              minutes pushes the deadline out by that much. That&apos;s
              deliberate: without it, a bid nobody has time to answer could
              decide the round.
            </P>
            <P>
              Outbid? Your USDG was never taken out of your control — it sits
              in the contract as a refund the instant someone bids higher, and
              you withdraw it whenever you like. Nothing is sent back to you
              automatically.
            </P>
            <Note>
              If nobody bids at all in a round, it closes with nothing
              launched and a new one opens immediately. There is always
              exactly one Club open.
            </Note>
          </Section>

          <Section id="fees" title="Fees">
            <Facts
              rows={[
                ["Winning bid", "Goes to the protocol treasury"],
                ["Trade fee, after launch", `${POOL_USDG.tradeFeeBps / 100}% of every buy and sell`],
                ["To the creator", `${POOL_USDG.creatorFeeShareBps / 100}% of that fee`],
                ["To the protocol", `${100 - POOL_USDG.creatorFeeShareBps / 100}% of that fee`],
              ]}
            />
            <P>
              The bid you win with doesn&apos;t become the coin&apos;s
              liquidity — it&apos;s the cost of the exclusive launch slot,
              paid to the protocol. Separately, and optionally, a winner can
              set aside their own first buy — up to {CLUB.maxDevBuyUsdg} USDG
              — which becomes their own opening position in the coin they
              just launched.
            </P>
            <P>
              After launch, trading works like any coin here: a{" "}
              {POOL_USDG.tradeFeeBps / 100}% fee on every buy and sell,{" "}
              {POOL_USDG.creatorFeeShareBps / 100}% of it to the coin&apos;s
              creator — the auction&apos;s winner — accruing in the contract
              until they claim it. Visible on the coin&apos;s page whether
              you&apos;re the creator or not.
            </P>
          </Section>

          <Section id="launch" title="Launch">
            <P>
              The moment the countdown reaches zero, the leading bid&apos;s
              draft launches on its own — no separate transaction from the
              winner, no waiting on us. A fixed supply of 1,000,000,000
              tokens deploys with no mint function, and the whole supply goes
              straight into a Uniswap v4 pool as locked single-sided
              liquidity, in the same transaction.
            </P>
            <P>
              Locked means what it says: the contract holding that liquidity
              has no function that can reduce a position or move one out.
              Nobody, including us, can pull it. The coin is indexed and
              tradeable — on this site and on any screener watching Uniswap —
              from its very first block, with no invisible period beforehand.
            </P>
            <Note>
              Finalizing a round is done by a bot the team runs, not a
              permissionless keeper anyone can trigger. If it&apos;s ever
              down past a round&apos;s deadline, nothing launches until
              it&apos;s back — there is no on-chain fallback, by design.
            </Note>
          </Section>

          <Section id="risks" title="Risks">
            <P>
              Coins launched here are made by whoever won that round&apos;s
              auction. They carry no rights, no claim on anything, and can go
              to zero. Most do.
            </P>
            <Ul>
              <li>
                <B>Names and pictures can be copied.</B> Check the contract
                address, not the name. It&apos;s on every coin page.
              </li>
              <li>
                <B>The winner can sell.</B> Their holding and their claimed
                fees are shown on the coin page. Look before you buy.
              </li>
              <li>
                <B>Transactions are irreversible.</B> Once a trade is final
                there&apos;s no undo and no support desk that can reverse it.
              </li>
              <li>
                <B>No snipe protection on a fresh launch.</B> Unlike the old
                per-transaction launch flow this replaced, there&apos;s no
                launch-window tax here — a coin is tradeable, and snipeable,
                from the block it launches in.
              </li>
            </Ul>
            <P>Nothing here is investment advice.</P>
          </Section>

          <Section id="contracts" title="Contracts">
            <P>
              Read them rather than taking our word for any of the above.
            </P>
            <Addresses
              rows={[
                [
                  "ClubAuction",
                  ROBINHOOD_TESTNET_CONTRACTS.clubAuction,
                  "The auction itself. Bidding, draft edits, refunds, finalize.",
                ],
                [
                  "PoolFactoryUsdg",
                  ROBINHOOD_TESTNET_CONTRACTS.poolFactoryUsdg,
                  "Deploys the token and its pool when a round finalizes.",
                ],
                [
                  "PoolVaultUsdg",
                  ROBINHOOD_TESTNET_CONTRACTS.poolVaultUsdg,
                  "Holds every launch's liquidity. The pool's hook. Cannot release it.",
                ],
                [
                  "AromaRouterUsdg",
                  ROBINHOOD_TESTNET_CONTRACTS.aromaRouterUsdg,
                  "Buy and sell any coin launched by a Club.",
                ],
              ]}
            />
            <P>
              ClubAuction&apos;s owner key can do exactly one thing:
              finalize a round once its countdown has passed — see{" "}
              <B>Launch</B> above for why that&apos;s a bot call, not a
              permissionless one. There is no pause, no upgrade, and no path
              from the owner to anyone&apos;s bid, refund or fees.
            </P>
            <P>
              The whole thing is public — contracts, indexer and this site —
              at <A href={SITE_REPO}>github.com/matco01/Aroma</A>. Readable
              and auditable, though not open source: it&apos;s under the
              Business Source License, which converts to MIT in 2030 rather
              than permitting a competing deployment today.
            </P>
          </Section>

          <Section id="data-api" title="Data API">
            <P>
              Every coin launched by a Club is a real Uniswap v4 pool, not a
              custom mechanism invisible to outside tools — so DexScreener,
              GeckoTerminal and any other indexer watching Uniswap already
              see it, natively, from the first block. There&apos;s no custom
              feed to integrate with for a Club-launched coin, unlike the
              bonding curve this replaced, which needed one because it
              wasn&apos;t a real AMM at all.
            </P>
            <P>
              The <code className="num text-[13px]">/api/dex/*</code> feed
              that used to serve that purpose remains in the codebase for the
              dormant curve system, but describes none of what launches
              through the Club.
            </P>
          </Section>

          <Section id="trading" title="Trading integration">
            <P>
              Trading a Club-launched coin means calling AromaRouterUsdg
              directly, or through the pool it created — every coin lives in
              its own Uniswap v4 pool, keyed by the token address, with
              AromaRouterUsdg as the router that keeps a sell to one signed
              transaction.
            </P>
            <Addresses
              rows={[
                [
                  "AromaRouterUsdg",
                  ROBINHOOD_TESTNET_CONTRACTS.aromaRouterUsdg,
                  "Buy and sell every coin a Club has launched.",
                ],
              ]}
            />
            <Endpoints
              rows={[
                [
                  "buy(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
                  "usdgIn is authorized by an EIP-2612 permit on USDG, not a prior approval — one signed transaction, same as sell.",
                ],
                [
                  "sell(address token, uint256 amount, uint256 minUsdgOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
                  "The permit here is on the launched token itself.",
                ],
              ]}
            />
            <Note>
              There is no quoteBuy/quoteSell view function here, unlike the
              old curve. A real Uniswap v4 pool is quoted through Uniswap&apos;s
              own v4 Quoter contract, which is a simulated call — quote with
              a raw eth_call rather than an ordinary contract read, and expect
              it to revert-and-return rather than behave like a view.
            </Note>
            <P>
              Events worth decoding, all from AromaRouterUsdg:
            </P>
            <Endpoints
              rows={[
                ["Bought(address token, address buyer, uint256 usdgIn, uint256 tokensOut)", "A buy went through."],
                ["Sold(address token, address seller, uint256 tokensIn, uint256 usdgOut)", "A sell went through."],
              ]}
            />
            <P>
              For the launch itself, ClubAuction emits{" "}
              <code className="num text-[13px]">
                ClubLaunched(uint256 clubId, address token, address winner, uint256 winningBid, uint256 devBuyUsdc)
              </code>{" "}
              the instant a round finalizes — the earliest point a new
              coin&apos;s address is knowable.
            </P>
          </Section>

          <Section id="network" title="Network">
            <Facts
              rows={[
                ["Chain", ROBINHOOD_TESTNET.name],
                ["Chain ID", String(ROBINHOOD_TESTNET.id)],
                ["Native gas token", "ETH"],
                ["Trading currency", "USDG"],
                ["Explorer", ROBINHOOD_TESTNET.explorer.replace("https://", "")],
              ]}
            />
            <P>
              Test funds come from{" "}
              <A href={ROBINHOOD_TESTNET.faucet}>the Robinhood Chain testnet
              faucet</A>. They have no monetary value, and neither does
              anything you buy with them.
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function Addresses({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="space-y-2">
      {rows.map(([name, addr, what]) => {
        const deployed = addr.toLowerCase() !== ZERO_ADDRESS;
        return (
          <div key={name} className="rounded-md border border-line bg-surface px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] text-ink">{name}</span>
              {deployed ? (
                <a
                  href={`${ROBINHOOD_TESTNET.explorer}/address/${addr}`}
                  target="_blank"
                  rel="noreferrer"
                  className="num shrink-0 text-[11.5px] text-ink-3 transition-colors hover:text-ink-2"
                >
                  Explorer ↗
                </a>
              ) : (
                <span className="shrink-0 text-[11.5px] text-warn">Not yet deployed</span>
              )}
            </div>
            {deployed && <div className="num mt-1 break-all text-[11.5px] text-ink-2">{addr}</div>}
            <p className="mt-1.5 text-[12.5px] text-ink-3">{what}</p>
          </div>
        );
      })}
    </div>
  );
}
