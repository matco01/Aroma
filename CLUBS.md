# Club coins

A design for invite-only coins on Aroma. **Nothing here is built.** This is the
spec, the reasoning behind each number, and the simulation results the numbers
came from.

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
| Seats per member | 3, granted on their first buy |
| Seats for the creator | 10, at launch |
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

## Open questions

- **How many seats does the creator get?** 10 is assumed throughout. It sets how
  fast a club can grow and how much wider the creator's branch is than anyone
  else's.
- **Do seats ever replenish?** Flat 3 forever is simplest and keeps them scarce.
  Earning more at volume milestones grows clubs faster and dilutes the feeling.
- **Should a club coin be visible to non-members?** Showing the member count and
  the tree while making it unbuyable is probably the point. Worth deciding
  deliberately.
- **What happens to a club coin's `graduated` flag and board placement**, given
  the board no longer shows milestones at all.
