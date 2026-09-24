import Link from "next/link";
import { CLUB } from "@/lib/arc";
import { AUCTION_CONTRACT, CLUB_CONTRACTS, NETWORK, SETTLEMENT, explorerUrl } from "@/lib/network";
import { AUCTION } from "@/lib/robinhood";
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
 * This describes the live system: invite-only club coins on Robinhood Chain,
 * settled in USDG, each launched by winning the Club auction. The Arc pool
 * system and the bonding curve before it still exist in the codebase, but
 * nothing on this page is about them.
 */

const nav = [
  { id: "overview", label: "Overview" },
  { id: "the-club", label: "The Club auction" },
  { id: "clubs", label: "Invites" },
  { id: "fees", label: "Fees" },
  { id: "launch", label: "Launch" },
  { id: "risks", label: "Risks" },
  { id: "contracts", label: "Contracts" },
  { id: "trading", label: "Trading integration" },
  { id: "network", label: "Network" },
];

const pct = (bps: number) => `${bps / 100}%`;

/** The share of a trade's fee at each level of the invite chain, in bps of the trade. */
function treeSchedule(levels: number): number[] {
  const out: number[] = [];
  let left = CLUB.treeFeeBps;
  for (let i = 1; i <= levels; i++) {
    const share = (left * 2) / 3;
    out.push(share);
    left -= share;
  }
  return out;
}

export function DocsView() {
  const [l1, l2, l3] = treeSchedule(3);
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
              Every coin on Aroma is a <B>club</B>. Only members can buy, and
              the way in is an invite from someone already inside. Every trade
              pays a fee, and most of it goes to the people who invited the
              trader, not to us.
            </P>
            <P>
              Clubs aren&apos;t launched on demand. There is one{" "}
              <B>Club auction</B> open at a time on {NETWORK.name}: a
              24-hour auction for the right to found the next one. Whoever
              is on top when the countdown hits zero gets their coin launched
              automatically, and becomes its creator.
            </P>
            <P>
              Everything is priced in <B>{SETTLEMENT.symbol}</B>, a
              dollar-backed stablecoin, not the chain&apos;s own gas token,
              which is ETH. A bid, a trade and a market cap are all{" "}
              {SETTLEMENT.symbol} amounts.
            </P>
            <P>
              Aroma never holds your funds. Your wallet signs and submits
              every transaction, and the contracts have no function that lets
              us move a token or a balance that isn&apos;t ours.
            </P>
          </Section>

          <Section id="the-club" title="The Club auction">
            <P>
              One auction is open at any moment. A bid sets the coin&apos;s
              draft identity (name, ticker, description, image and links) in
              the same transaction. Whoever is on top can keep editing that
              draft for free, with a separate call that moves no funds, right
              up until the countdown ends. Everyone else sees the draft as a
              preview.
            </P>
            <Facts
              rows={[
                ["Round length", `${AUCTION.roundDurationSeconds / 3600} hours`],
                ["Minimum opening bid", `${AUCTION.minOpeningBidUsdg} ${SETTLEMENT.symbol}`],
                ["Minimum raise to outbid", pct(AUCTION.minBidIncrementBps)],
                ["Anti-snipe extension", `${AUCTION.antiSnipeExtensionSeconds / 60} minutes`],
                ["Winning bid", "Goes to the protocol treasury"],
              ]}
            />
            <P>
              A bid placed inside the last{" "}
              {AUCTION.antiSnipeExtensionSeconds / 60} minutes pushes the
              deadline out by that much, so a bid nobody has time to answer
              can&apos;t decide the round.
            </P>
            <P>
              Outbid? Your {SETTLEMENT.symbol} is never taken. It sits in the
              contract as a refund the moment someone bids higher, and you
              withdraw it whenever you like.
            </P>
            <P>
              A bid can carry an optional <B>first buy</B> of up to{" "}
              {AUCTION.maxFirstBuyUsdg} {SETTLEMENT.symbol}. If the bid wins,
              that amount buys the new coin inside the launch transaction, so
              nobody can buy ahead of it, and the tokens land in the
              winner&apos;s wallet. If the bid loses, it&apos;s refunded with
              the bid.
            </P>
            <Note>
              If nobody bids in a round, it closes with nothing launched and a
              new one opens immediately. There is always exactly one auction
              open.
            </Note>
          </Section>

          <Section id="clubs" title="Invites">
            <P>
              The auction&apos;s winner founds the club and holds its first{" "}
              <B>{CLUB.creatorSeats} seats</B>. Every member after that gets{" "}
              <B>{CLUB.memberSeats}</B>. A seat is a place for one person you
              invite.
            </P>
            <Ul>
              <li>
                <B>An invite is a link.</B> Making one costs nothing: it&apos;s
                a signature, not a transaction. One link works for as many
                people as you have seats left, and whoever uses it first gets
                in.
              </li>
              <li>
                <B>A seat is used by buying, not by being invited.</B> Joining
                means buying at least ${CLUB.minJoinUsd} with the link. An
                invite nobody uses costs you nothing, and a seat is never
                wasted on someone who doesn&apos;t show up.
              </li>
              <li>
                <B>Links expire and can be cancelled.</B> A link lasts{" "}
                {CLUB.inviteTtlSeconds / 86_400} days. Cancelling kills every
                link you&apos;ve handed out; anyone already in stays in.
              </li>
              <li>
                <B>Your place is permanent.</B> Who invited you is written once,
                when you join, and never changes. Nobody can move you under
                them later.
              </li>
              <li>
                <B>Selling is never gated.</B> The invite only controls buying.
                Anyone holding the coin, member or not, can always sell.
              </li>
            </Ul>
          </Section>

          <Section id="fees" title="Fees">
            <Facts
              rows={[
                ["Trade fee", `${pct(CLUB.tradeFeeBps)} of every buy and sell`],
                ["To the protocol", pct(CLUB.protocolFeeBps)],
                ["To the club's creator", pct(CLUB.rootFeeBps)],
                ["Up the trader's invite chain", pct(CLUB.treeFeeBps)],
              ]}
            />
            <P>
              The {pct(CLUB.treeFeeBps)} walks up from whoever invited the
              trader. Each person takes two thirds of what&apos;s left and
              passes a third up:
            </P>
            <Facts
              rows={[
                ["Whoever invited the trader", `${(l1 / 100).toFixed(3)}%`],
                ["Whoever invited them", `${(l2 / 100).toFixed(3)}%`],
                ["One level further", `${(l3 / 100).toFixed(3)}%`],
                ["…and so on, up to", `${CLUB.maxDepth} levels`],
              ]}
            />
            <P>
              When the chain runs out before {CLUB.maxDepth} levels,
              whatever is left goes to the last person reached, usually the
              creator. A trade by someone with no inviter, like the creator
              trading their own coin, has no chain to pay, and that share
              goes to the protocol.
            </P>
            <P>
              Earnings from every club you&apos;re in add up in one balance,
              collected in one transaction from the coin page. The fee is
              charged by the pool itself, so it applies whichever app or
              router the trade goes through.
            </P>
          </Section>

          <Section id="launch" title="Launch">
            <P>
              When the countdown reaches zero, the leading bid&apos;s draft
              launches. The winner doesn&apos;t need to send anything. A fixed
              supply of 1,000,000,000 tokens deploys with no mint function,
              and the whole supply goes straight into a Uniswap v4 pool as
              locked single-sided liquidity, in the same transaction.
            </P>
            <P>
              Locked means what it says: the contract holding that liquidity
              has no function that can reduce a position or move one out.
              Nobody, including us, can pull it.
            </P>
            <Note>
              Finalizing a round is done by a bot the team runs, not a
              permissionless keeper anyone can trigger. If it&apos;s ever
              down past a round&apos;s deadline, nothing launches until
              it&apos;s back. There is no on-chain fallback, by design.
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
                <B>The winner can sell.</B> Their holding and their earnings
                are on the coin page. Look before you buy.
              </li>
              <li>
                <B>Invite fees reward growth, not value.</B> People earn from
                inviting you. That is a reason for them to invite you, not a
                reason the coin is worth buying.
              </li>
              <li>
                <B>Transactions are irreversible.</B> Once a trade is final
                there&apos;s no undo and no support desk that can reverse it.
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
                  AUCTION_CONTRACT,
                  "The auction. Bidding, draft edits, refunds, finalize.",
                ],
                [
                  "ClubFactoryUsdg",
                  CLUB_CONTRACTS.clubFactory,
                  "Deploys the winner's token and its pool. Takes launches from the auction only.",
                ],
                [
                  "ClubVaultUsdg",
                  CLUB_CONTRACTS.clubVault,
                  "The pool's hook. Holds the liquidity, gates buys on membership, splits fees up the invite chain.",
                ],
                [
                  "ClubRouterUsdg",
                  CLUB_CONTRACTS.clubRouter,
                  "Buy, sell, and join with an invite.",
                ],
              ]}
            />
            <P>
              ClubAuction&apos;s owner key can do exactly one thing: finalize a
              round once its countdown has passed. The vault&apos;s owner can
              withdraw the protocol&apos;s share of fees. There is no pause, no
              upgrade, and no path from either to anyone&apos;s bid, refund,
              tokens or earnings.
            </P>
            <P>
              The whole thing is public (contracts, indexer and this site) at{" "}
              <A href={SITE_REPO}>github.com/matco01/Aroma</A>. Readable and
              auditable, though not open source: it&apos;s under the Business
              Source License, which converts to MIT in 2030.
            </P>
          </Section>

          <Section id="trading" title="Trading integration">
            <P>
              Every coin is a real Uniswap v4 pool, so screeners watching
              Uniswap see it from its first block. Buying goes through
              ClubRouterUsdg, because it is the one sender whose word the
              hook takes about who is buying. From anywhere else, the buyer
              is the transaction&apos;s sender, and must already be a member.
            </P>
            <Endpoints
              rows={[
                [
                  "buy(address token, uint256 usdgIn, uint256 minTokensOut, Permit permit)",
                  "For members. Permit is (deadline, v, r, s), an EIP-2612 permit on USDG; pass zeros if an allowance already covers usdgIn.",
                ],
                [
                  "buyWithInvite(address token, uint256 usdgIn, uint256 minTokensOut, Invite invite, Permit permit)",
                  `Joins and buys in one transaction. Invite is (inviter, nonce, deadline, signature). At least ${CLUB.minJoinUsd} ${SETTLEMENT.symbol} to join; for someone already in, the invite is ignored.`,
                ],
                [
                  "sell(address token, uint256 amount, uint256 minUsdgOut, Permit permit)",
                  "Open to anyone. The permit here is on the coin itself.",
                ],
              ]}
            />
            <P>Events worth decoding:</P>
            <Endpoints
              rows={[
                ["ClubRouterUsdg.Bought(token, buyer, usdcIn, tokensOut)", "A buy went through."],
                ["ClubRouterUsdg.Sold(token, seller, tokensIn, usdcOut)", "A sell went through."],
                ["ClubVaultUsdg.Joined(token, member, inviter)", "Someone joined a club."],
                ["ClubVaultUsdg.Credited(token, account, level, usdc)", "One share of one trade's fee. Level 0 is the creator."],
                [
                  "ClubAuction.ClubLaunched(clubId, token, winner, winningBid, devBuyUsdc)",
                  "A round finalized. The earliest point a new coin's address is known.",
                ],
              ]}
            />
          </Section>

          <Section id="network" title="Network">
            <Facts
              rows={[
                ["Chain", NETWORK.name],
                ["Chain ID", String(NETWORK.id)],
                ["Native gas token", NETWORK.currency.symbol],
                ["Trading currency", SETTLEMENT.symbol],
                ...(NETWORK.explorer
                  ? [["Explorer", NETWORK.explorer.replace("https://", "")] as [string, string]]
                  : []),
              ]}
            />
            {NETWORK.testnet && NETWORK.faucet && (
              <P>
                Test funds come from <A href={NETWORK.faucet}>the testnet faucet</A>.
                They have no monetary value, and neither does anything you buy
                with them.
              </P>
            )}
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

function Addresses({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="space-y-2">
      {rows.map(([name, addr, what]) => {
        const deployed = /^0x[0-9a-fA-F]{40}$/.test(addr) && !/^0x0{40}$/.test(addr);
        const link = deployed ? explorerUrl(`/address/${addr}`) : null;
        return (
          <div key={name} className="rounded-md border border-line bg-surface px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] text-ink">{name}</span>
              {deployed ? (
                link && <a
                  href={link}
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
