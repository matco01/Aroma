import { CURVE } from "./arc";

/* Deterministic fake data. Seeded so SSR and the client agree exactly.
   Replace this module with Arc RPC + an indexer and nothing above it moves. */

export type Trade = {
  id: string;
  side: "buy" | "sell";
  account: string;
  usd: number;
  tokens: number;
  agoSeconds: number;
};

export type Holder = {
  account: string;
  pctOwned: number;
  isCurve?: boolean;
  isDev?: boolean;
};

export type Reply = {
  id: string;
  account: string;
  agoSeconds: number;
  body: string;
  likes: number;
};

export type Coin = {
  id: string;
  name: string;
  ticker: string;
  description: string;
  /** Gateway URL for the creator's image, or "" to fall back to art. */
  imageUrl: string;
  creator: string;
  contract: string;
  createdAgoSeconds: number;
  priceUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  change24hPct: number;
  holders: number;
  replies: number;
  raisedUsd: number;
  graduated: boolean;
  hue: number;
  seed: number;
  history: number[];
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES: [string, string, string][] = [
  ["Dollar Doge", "DOGEUSD", "the only doge that settles at par. we have a chart and a dream"],
  ["Gas Is Free", "GASFREE", "on arc your gas is a dollar. on arc your dollar is gas. think about it"],
  ["Peg Enjoyer", "PEG", "i enjoy the peg. the peg enjoys me. nothing else matters"],
  ["Redeemable", "RDMB", "not redeemable. it is a name not a promise"],
  ["Six Decimals", "SIX", "for everyone who lost a run to eighteen. never again"],
  ["Sub Second", "SUBSEC", "finality faster than you can regret the buy"],
  ["Stable Genius", "SGENIUS", "very stable. extremely genius. mostly stable"],
  ["Attestation", "ATTEST", "monthly reserves report but it is a memecoin"],
  ["Full Reserve", "RESERVE", "backed 1:1 by vibes held in a bankruptcy remote wallet"],
  ["Bank Run", "BANKRUN", "the only chart that goes up when everyone leaves"],
  ["Wire Transfer", "WIRE", "settles in three to five business blocks"],
  ["Treasury Bill", "TBILL", "yield bearing in spirit only"],
  ["Basis Point", "BIP", "one hundredth of one percent of your dignity"],
  ["Depeg Insurance", "DEPEG", "we insure nothing. we are the risk"],
  ["Mint Burn", "MINTBURN", "we minted. we will not burn. sorry"],
  ["Arc Angel", "ANGEL", "first token deployed on the chain. allegedly"],
  ["Osaka Baseline", "OSAKA", "evm compliant and emotionally unavailable"],
  ["Malachite", "MALA", "named after the consensus. traded on impulse"],
  ["Cross Chain", "CCTP", "burns here mints there loses value everywhere"],
  ["Programmable", "PROG", "money that does what you tell it. mostly down"],
  ["Compliance Bro", "COMPLY", "kyc'd my own wallet for fun"],
  ["Deterministic", "DETERM", "the outcome was always this"],
  ["Off Ramp", "OFFRAMP", "there is not one"],
  ["Settlement", "SETTLE", "we settle. you do not"],
  ["Cash Equivalent", "CASHEQ", "equivalent to cash the way i am equivalent to rich"],
  ["Par Value", "PAR", "one dollar forever. terms and conditions apply"],
  ["Custody", "CSTDY", "not your keys not your dollar not your problem"],
  ["Float", "FLOAT", "the money that sits between two people who trust each other"],
  ["Rails", "RAILS", "we are the rails. you are the train. it is fine"],
  ["Nostro", "NOSTRO", "our account with you. mostly empty"],
  ["Vostro", "VOSTRO", "your account with us. entirely empty"],
  ["Netting", "NETT", "cancelling obligations until nobody owes anybody anything"],
  ["Liquidity Pool", "LPOOL", "come on in the liquidity is fine"],
  ["Slippage", "SLIP", "the fee you did not read about"],
  ["Front Run", "FRONT", "we get there first. that is the whole product"],
  ["Block Space", "BSPACE", "real estate but worse"],
  ["Mempool", "MEMPOOL", "where transactions wait and think about what they did"],
  ["Finality", "FINAL", "it is over. it was over a second ago"],
  ["Gwei Twenty", "GWEI20", "the floor is twenty and the ceiling is imagination"],
  ["Confidential", "CONFID", "opt in privacy with selective disclosure to my group chat"],
  ["Institutional", "INSTL", "blackrock is not in this. neither is visa. neither am i"],
  ["Fixed Supply", "FIXED", "one billion. that is it. that is the tweet"],
  ["Graduation Day", "GRAD", "we are gonna make it to twenty four thousand"],
  ["Bonding Curve", "CURVE", "the math is public the outcome is not"],
  ["No Rug", "NORUG", "cannot rug. liquidity locked. read the contract coward"],
  ["Diamond Hands", "DIAMOND", "holding since block two"],
  ["Exit Liquidity", "EXITLQ", "at least this one is honest about it"],
  ["Par For Par", "P4P", "a dollar in a dollar out and a joke in the middle"],
];

const ADDR_CHARS = "0123456789abcdef";
function addr(rnd: () => number): string {
  let s = "0x";
  for (let i = 0; i < 40; i++) s += ADDR_CHARS[Math.floor(rnd() * 16)];
  return s;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function buildCoin(index: number): Coin {
  const rnd = mulberry32(1337 + index * 7919);
  const [name, ticker, description] = NAMES[index % NAMES.length];

  // Roughly a quarter of the board has graduated; the rest is still climbing.
  const graduated = rnd() < 0.26;
  const progress = graduated ? 1 : Math.pow(rnd(), 1.7);
  const raisedUsd = graduated
    ? CURVE.graduationTargetUsd
    : Math.max(40, progress * CURVE.graduationTargetUsd);

  const marketCapUsd = graduated
    ? CURVE.graduationMarketCapUsd * (1 + rnd() * 22)
    : 4_200 + progress * (CURVE.graduationMarketCapUsd - 4_200);

  const priceUsd = marketCapUsd / CURVE.totalSupply;

  // Older coins have had more time to accumulate holders and volume.
  const createdAgoSeconds = Math.floor(20 + Math.pow(rnd(), 2.4) * 900_000);
  const volume24hUsd = marketCapUsd * (0.15 + rnd() * 2.6);
  const holders = Math.max(3, Math.floor((marketCapUsd / 900) * (0.4 + rnd())));

  // Price history as a random walk rescaled to land on the current price.
  const points = 48;
  const history: number[] = [];
  let v = 1;
  for (let i = 0; i < points; i++) {
    v *= 1 + (rnd() - 0.47) * 0.16;
    history.push(v);
  }
  const scale = priceUsd / history[points - 1];
  for (let i = 0; i < points; i++) history[i] *= scale;

  // Derived, not rolled separately: the headline percentage has to be the same
  // number the chart draws, over the same window the chart calls 24h.
  const dayOpen = history[points - 40];
  const change24hPct = ((priceUsd - dayOpen) / dayOpen) * 100;

  return {
    id: slug(name),
    name,
    ticker,
    description,
    imageUrl: "",
    creator: addr(rnd),
    contract: addr(rnd),
    createdAgoSeconds,
    priceUsd,
    marketCapUsd,
    volume24hUsd,
    change24hPct,
    holders,
    replies: Math.floor(rnd() * 240),
    raisedUsd,
    graduated,
    hue: Math.floor(rnd() * 360),
    seed: 1337 + index * 7919,
    history,
  };
}

export const COINS: Coin[] = NAMES.map((_, i) => buildCoin(i));

export function getCoin(id: string): Coin | undefined {
  return COINS.find((c) => c.id === id);
}

export function tradesFor(coin: Coin): Trade[] {
  const rnd = mulberry32(coin.seed + 11);
  return Array.from({ length: 22 }, (_, i) => {
    const side: Trade["side"] = rnd() < 0.58 ? "buy" : "sell";
    const usd = Math.round((5 + Math.pow(rnd(), 2.2) * 3800) * 100) / 100;
    return {
      id: coin.id + "-t" + i,
      side,
      account: addr(rnd),
      usd,
      tokens: usd / coin.priceUsd,
      agoSeconds: Math.floor(12 + i * (40 + rnd() * 900)),
    };
  });
}

export function holdersFor(coin: Coin): Holder[] {
  const rnd = mulberry32(coin.seed + 23);
  const curveShare = coin.graduated
    ? 0
    : 100 - (coin.raisedUsd / CURVE.graduationTargetUsd) * 78;
  const rows: Holder[] = [];
  if (!coin.graduated) {
    rows.push({ account: "bonding curve", pctOwned: curveShare, isCurve: true });
  }
  let remaining = 100 - curveShare;
  const n = 9;
  for (let i = 0; i < n; i++) {
    const take = i === n - 1 ? remaining : remaining * (0.14 + rnd() * 0.3);
    remaining -= take;
    rows.push({
      account: i === 0 ? coin.creator : addr(rnd),
      pctOwned: take,
      isDev: i === 0,
    });
  }
  return rows.sort((a, b) => b.pctOwned - a.pctOwned);
}

const REPLY_BODIES = [
  "chart looks like a staircase to somewhere good",
  "dev is in the comments which is either very good or very bad",
  "bought at 4k mcap. not selling until graduation or death",
  "why is the curve at 61% and the volume at zero. explain",
  "first token where i did not have to go get gas first. this is nice actually",
  "locked liquidity or i walk",
  "someone just took 3k out of this. be careful",
  "the ticker is genuinely funny. that is worth something",
  "holders count doubled in an hour",
  "we are so back",
  "down 40% and i am still up. that is the arc experience",
  "reminder that the supply is fixed and the contract is public. read it",
];

export function repliesFor(coin: Coin): Reply[] {
  const rnd = mulberry32(coin.seed + 41);
  return Array.from({ length: 7 }, (_, i) => ({
    id: coin.id + "-r" + i,
    account: addr(rnd),
    agoSeconds: Math.floor(90 + i * (300 + rnd() * 5000)),
    body: REPLY_BODIES[Math.floor(rnd() * REPLY_BODIES.length)],
    likes: Math.floor(rnd() * 40),
  }));
}
