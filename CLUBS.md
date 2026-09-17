# Club coins

A design for invite-only coins on Aroma: the spec, the reasoning behind each
number, and the simulation results the numbers came from.

**Status:** contracts and frontend are built, tested, and rehearsed end to end
on a fork of Arc mainnet — including through a real browser. **Not live yet.**
Everything in the app is gated on the club contracts having mainnet addresses,
so until they do, the site behaves exactly as it does without clubs. See
[Implementation](#implementation) for the decisions the contracts made, and
[Before clubs go live](#before-clubs-go-live) for what is left.

---

## The idea

A club coin can only be bought by someone who was invited. The creator seeds
the first invites, every member who buys gets 3 of their own, and the record of
who invited whom is permanent and public.

Trading fees flow back up that tree. You earn from the people you invited, from
the people *they* invited, and so on — so an invite is worth spending carefully
and worth following up on.

Normal Aroma coins are unchanged. This is a mode a creator picks at launch.

### Why bother

Every launchpad competes on the same axis: who can list the most coins the
fastest. This is the opposite — a coin that is *harder* to buy, where getting
in is a thing you had to be given.

It also solves the distribution problem underneath it. Aroma's bottleneck is
not mechanics, it is that nobody knows a coin exists. Paying people to bring
people is the oldest fix there is, and an invite tree is that fix with the
receipts kept on-chain instead of in an affiliate dashboard.

---

## Fees

A club coin trades at **1.5%** rather than 1%. Every buy and sell, in USDC, the
same as normal coins.

| | bps | |
| --- | --- | --- |
| Protocol | 30 | unchanged from a normal coin |
| Creator root | 10 | every trade, any depth, forever |
| Invite tree | 110 | split across up to 10 levels |

### The tree schedule

Each level pays **a third of the level below it**, starting at 73.3 bps:

| Level | bps | Per $1,000 traded |
| --- | --- | --- |
| 1 — you invited them | 73.3 | **$7.33** |
| 2 | 24.4 | $2.44 |
| 3 | 8.1 | $0.81 |
| 4 | 2.7 | $0.27 |
| 5 | 0.9 | $0.09 |
| 6–10 | 0.3, 0.1, 0.04, 0.01, 0.005 | dust |

Thirds are chosen so the series converges: `73.3 / (1 - 1/3) = 110`. However
deep the tree goes, the total can never exceed the budget, so the schedule is
safe at any depth by construction rather than by a cap.

**Unfilled levels roll up** to the nearest ancestor that exists, rather than
falling back to the protocol. Without this the protocol quietly collects 37%
while advertising 30% — real trees are shallow, so most trades never fill ten
levels. See the simulation section.

### Why not a gentler curve

A gentler decay (each level 2/3 of the last rather than 1/3) looks like it
should reward deep trees, and in a *full* tree it does — level 5 would pay 16×
what level 1 pays, because there are 243 people there instead of 3.

Simulated against realistic trees it does the opposite, at every engagement
level tested. The reason is the roll-up rule: a gentle curve parks most of the
budget at levels 4–8, most chains terminate before then, and that money rolls
up to whoever is nearest the top — usually the creator. Measured on a club with
1.5 invites per member: the best inviter earns **$1,698 under thirds against
$873 under two-thirds**, while the creator's take *rises* from $7,403 to
$8,174.

A gentle curve does not reward deep builders. It reroutes money to the root.

---

## The tree

**One tree per coin.** Every member has exactly one position in it and one
person above them. A member holds a different position in every club they are
in; nothing connects them.

**Your position is permanent.** Whoever invited you is written once and never
changes, which is also what makes cycles impossible — you cannot be invited
twice, so walking upward always terminates.

**Your earning radius is 10 levels**, which is at most 88,572 people below you
if everyone fills their 3 seats. The club itself has no size or depth limit; a
member 30 levels down trades normally and pays their own 10 nearest ancestors.

The cap exists for gas, not for economics: each level is a storage write on
every swap, and an uncapped chain is a denial-of-service — a 1,000-deep chain
would need 7M gas per trade and the coin would be untradeable. Ten levels costs
about $0.004 per trade on Arc, and in realistic clubs it earns the same as a cap
of 5 because almost nobody is ever that deep. It is set high because it is
nearly free and only ever helps.

### The creator's position

The creator is the root, and gets two advantages:

- **10 seats instead of 3**, so their branch is three times wider at every
  level.
- **The 10 bps root cut**, which has no radius — it applies to every member of
  the club at any depth, forever.

The root cut is the important one. Without it a creator whose club reached
295,241 people would earn from the 88,572 within reach and nothing else. With
it, being the founder is structurally different from being early, which is the
point.

---

## Invites

### Seats, not vouchers

A member has **3 seats**. The creator has 10. A seat is consumed **when someone
redeems it by buying**, not when the invite is sent.

This is the whole trick. If invites burned on send, every invite spent on
someone who never buys is wasted, and people would hoard them. Instead you can
hand out as many invite links as you like — the first three people who actually
buy take your seats, and the rest lapse harmlessly.

### How a link works

An invite is an **EIP-712 signature**, not a transaction. The inviter signs:

```
Invite(address token, address inviter, uint256 nonce, uint256 deadline)
```

That signature is encoded into a URL. Sending an invite costs no gas and needs
no transaction — which matters, because most invites will never be redeemed.

Redeeming happens inside the invitee's **first buy**. The router passes the
signature through, and the contract:

1. verifies the signature is the inviter's,
2. checks the inviter still has a free seat,
3. checks the invitee has no inviter on this coin already,
4. writes `inviterOf[token][invitee] = inviter`, consumes the seat,
5. grants the invitee their own 3 seats,
6. lets the buy through.

From then on that wallet can buy the coin through **any route** — our site,
GMGN, Maestro, raw Uniswap — because membership is on-chain state, not a
session. The hook checks the buyer against the allowlist using `tx.origin`, or
a buyer passed through by our router for smart-contract wallets.

### Links are bearer instruments

One signature can be redeemed by up to 3 people, because the scarce thing is
the seat, not the signature. If a link is posted publicly, the first three
buyers take the seats. The invite page shows **"2 of 3 seats left"** live, which
turns that from a bug into urgency.

An inviter can invalidate every outstanding link by bumping an on-chain nonce.
That is the only on-chain action invites require, and only if something has
gone wrong.

### Rules

| | |
| --- | --- |
| Seats per member | 3, granted on their first buy, never replenished |
| Seats for the creator | 10, at launch, the same for every club |
| Consumed | on redemption, not on send |
| Transferable | no |
| Revocable | only by invalidating outstanding links, never after redemption |
| Re-invitable | no — one inviter per wallet per coin, forever |

### Selling is never gated

Anyone holding the coin can sell into the pool, member or not. Gating the exit
would make it a honeypot. Only *buying* is restricted.

Note that this makes the club porous by design: a member can buy and sell
tokens to a non-member off-platform. That is accepted. The gate controls who
can buy at the pool price, not who can end up holding.

---

## What the simulations say

Run against trees built from a realistic invite distribution — half of members
invite nobody — with lognormal volume and a third of members never trading.

### A $100k club coin, ~85 members

| | |
| --- | --- |
| Total fees | $1,500 |
| Protocol | ~$300 |
| Creator | ~$315 |
| All inviters | ~$864 |
| Best single inviter | ~$122 |

### Most members earn nothing

**Around 54% of members earn essentially zero**, and the top five inviters take
about half of everything paid out to non-creators. That is correct — they are
buyers, not promoters — but it means most people's experience of this feature is
a zero balance. The UI should show *what you earn per invitee who trades*, never
a projected total.

### Depth does not predict earnings

From one typical club, the top earners sat at depths 1, 5, 8, 4, 7 and 11.
Someone eleven levels down out-earned most people above them. What predicts
earnings is how many people you invited and whether they trade — not when you
joined. This is the honest answer to the "late joiners get nothing" objection,
and it holds because payouts are per-level relative to the trader rather than
skimmed from a shared pot.

### Two of the top five earners had traded nothing at all

They only invited people. That is the mechanic working: you can earn from a coin
you have never bought.

### The fee increase has room, but the protocol funds it

1.5% is a 3% round trip instead of 2%, which will cost some volume. Inviters can
absorb a **45% drop** in volume before the bigger slice loses to the smaller pie.
The protocol has no such cushion: 30 bps of reduced volume is simply less money,
with no upside anywhere. That is the trade — buying distribution with protocol
revenue.

### Scale matters far more than any of this

| Volume | Best inviter earns |
| --- | --- |
| $100k | ~$122 |
| $1M | ~$612 |
| $10M | ~$6,116 |

The fee structure is a 1.8× lever. Coin size is a 100× lever. This is worth
building as a distribution machine, not as a way to make a small coin pay.

---

## Anti-abuse

**Sybil chains lose money.** Someone could chain their own wallets and trade
from the bottom to collect every level. They would pay 150 bps and recover at
most 110. As long as the tree payout stays below the total fee, self-dealing is
a donation. Keep that invariant and there is nothing to police.

**Payment is for trading, never for recruiting.** No bounty is ever paid for an
invite being accepted — only a share of fees from real trades. This is the line
between affiliate tiering, which is ordinary and which every major exchange
runs, and a pyramid scheme, which is not. It is a constraint on the design, not
a detail.

**Cycles are impossible**, since a wallet can only ever be invited once.

---

## What this costs to ship

**A new hook, which means a new deployment.** A v4 pool's hook address is part
of its `PoolKey` and fixed at initialization, so the currently deployed
`PoolVault` can never do any of this. Club coins need a new vault, factory and
router, and existing coins stay on the old ones permanently.

That is the same migration the launch-window tax needs, and the same one
holder-dividends would need. If more than one of these is happening, they should
happen together — every separate migration strands another set of coins.

---

## Implementation

Three contracts in `contracts/src/club/`, deployed beside the pool system by
`script/DeployClub.s.sol`, sharing nothing with it but the token contract and
Uniswap's PoolManager. **Normal coins are untouched**: their vault, factory and
router are not modified, and a normal coin was launched and traded on the same
fork as the club rehearsal to prove it.

| Contract | Role |
| --- | --- |
| `ClubVault` | The hook. Same pool geometry as `PoolVault`; gates buys, redeems invites, walks the tree. |
| `ClubFactory` | `PoolFactory` with the creator's dev buy identified to the hook. |
| `ClubRouter` | Buys, sells, and `buyWithInvite` — the only way to redeem an invite. |

### Decisions the spec had left open

**Who the hook believes is trading.** Swaps from `ClubRouter` or `ClubFactory`
state the trader in hook data; everything else is `tx.origin`. The router is
what makes smart-contract wallets work at all, and `tx.origin` is what lets a
member buy through any terminal. Hook data from any other sender is ignored
entirely — anyone can call the pool manager claiming to be a member, and the
test suite proves such a claim is refused. Router and factory are set once by
the owner and can never change, so the owner cannot later install a router that
lies about identity.

**A join needs at least 1 USDC.** Seats are consumed by buying so they aren't
wasted, and without a floor a one-wei buy would count — a publicly posted link
could have its seats burned for nothing.

**The tree split has no table.** Each level takes two thirds of what is left and
passes a third up; the deepest ancestor reached takes the remainder. That is the
73.3 / 24.4 / 8.1 schedule, with the roll-up built in, and with no wei lost to
rounding: the vault's balance equals what it owes exactly, checked in tests and
on the fork.

**A trader with nobody above them pays no tree.** That is the creator trading
their own coin, or a non-member selling tokens they were sent. Their 110 bps go
to the protocol. It means a creator's dev buy on a club coin sends 140 bps to
the protocol, against 30 on a normal coin — worth knowing, and easy to change if
it should go to the creator instead.

**One balance to claim, not one per club.** Everything a member earns across
every club is withdrawn in one transaction. Protocol revenue is one balance too.
Per-club figures live in the `Credited` events.

**Invite signatures accept the key first, then ERC-1271.** OpenZeppelin's
`SignatureChecker` picks ERC-1271 for any address with code — which, since
EIP-7702, includes ordinary accounts carrying a delegation. Those accounts still
sign with their own key, and the library never checks it. Found on the Arc fork,
where anvil's first account carries a delegation and every invite it signed was
refused while being valid. Wallets are putting delegations on user accounts, so
this is the case to get right. Contract wallets like a Safe still work through
the ERC-1271 branch, and both are tested.

### Measured

On a fork of Arc mainnet, from receipts:

| Buy, by levels above the buyer | Gas | At 20 gwei |
| --- | --- | --- |
| 0 — the creator | 135,002 | $0.0027 |
| 1 | 140,113 | $0.0028 |
| 3 | 160,227 | $0.0032 |
| 10 | 230,405 | $0.0046 |
| 12 — past the cap | 235,237 | $0.0047 |

A normal-coin buy is 138,798. Joining costs more — 245k–358k — because it writes
new membership state. Launching a club is 1,621,256 against 1,587,760 for a
normal coin.

31 tests, run against Uniswap's deployed PoolManager. The ones guarding the gate
were mutation-checked: removing the gate, trusting hook data from any sender,
dropping the roll-up, and restoring OpenZeppelin's signature check are each
caught.

## Frontend

- **Launch form** offers Open or Club, shown only once club contracts exist.
- **Coin page** shows a `club` badge, and a club panel in place of the
  creator-fees card: your seats, who invited you, a *Create invite link* button,
  and your earnings across every club with one Claim.
- **Invite links** are `/coin/0x…?invite=…` — the invite packed into 135
  characters. Opening one tells you who invited you before you connect, checks
  the invite against the vault before you sign, and turns the buy button into
  *Join & buy*.
- **Without an invite** the buy button reads *Invite only* and explains why.
  Selling is always available.
- **The board** marks club coins so nobody clicks one expecting to buy it.

`scripts/club-trade-check.ts` drives the trade functions against a fork (15
checks, including that a wallet's EIP-712 signature matches the vault's digest
exactly). `scripts/club-check.mjs` drives the whole flow through the UI with
three separate wallets (22 checks): a creator launches a club and makes a link,
someone joins with it, a stranger is refused, and a normal coin still trades.

The no-indexer data path was generalised to read both systems. Its output for
normal coins was diffed against the original code on identical chain state and
is identical; its fee inversion was checked over 400,000 amounts against the
original 1% formula with no difference.

## Before clubs go live

1. **Index clubs in the subgraph.** Production reads the board from Goldsky,
   and the deployed subgraph does not watch the club factory, so a club coin
   launched today would trade but not appear on the board. The swap handler also
   reconstructs amounts assuming a 1% fee; it needs the coin's own rate, and its
   output for normal coins has to stay identical.
2. **Deploy the contracts** with `script/DeployClub.s.sol`, verify the bytecode,
   and accept ownership.
3. **Fill `ARC_MAINNET_CLUB_CONTRACTS`** in `src/lib/arc.ts`. That is the switch
   that turns the feature on.

## Decided

**The creator gets 10 seats, fixed for every club.** Seats never replenish, so
the creator's seats are what keep a club alive when members don't invite. In
the realistic case where most members invite nobody:

| Creator seats | Median club | Clubs that barely grow |
| --- | --- | --- |
| 3 | 14 members | 39% |
| 5 | 29 | 19% |
| 10 | 89 | 3% |
| 20 | 239 | 0% |

At 3, four clubs in ten never get going. At 10 almost none stall and it still
feels exclusive. When members are keen, the seed count stops mattering: clubs
grow whatever the creator started with. It is fixed rather than picked at
launch so every club starts on equal terms.

**Seats never replenish.** Each member gets 3, once, on their first buy. That
keeps them scarce, which is the point of the whole feature.

**Club coins are visible to everyone.** Non-members see the coin, its price,
its member count and its tree, and a buy box that tells them it is invite-only.
Seeing a club you're not in is part of the feeling.

One consequence to design for: terminals and screeners will index a club coin
like any other pool, because it is one. A non-member who tries to buy through a
bot will have the transaction revert and pay gas for it. The coin page should
say "invite-only" plainly, and the coin's metadata should too, so a bot user
who looks it up has a chance to find out before trying.

## Open

- **Where club coins sit on the board.** Deferred.
