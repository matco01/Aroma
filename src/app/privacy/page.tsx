import type { Metadata } from "next";
import { LegalPage, Clause, T, List, Item, S } from "@/components/legal";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Aroma collects, which is close to nothing.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="6 September 2026">
      <Clause title="The short version">
        <T>
          We do not have accounts, so we do not know who you are. We set no
          cookies, run no analytics, and use no tracking pixels. We have never
          asked for your name or email and there is nowhere to give them.
        </T>
        <T>
          What we do process is listed below, and it is short enough to read.
        </T>
      </Clause>

      <Clause title="Your wallet address">
        <T>
          When you connect a wallet, this site sees its public address. It uses
          that to show your balance and your holdings.
        </T>
        <T>
          We do not store it. Your address and every trade you make are already
          public on the blockchain — written there by your own transaction, not
          by us — and anyone can read them, including with tools that group
          addresses together. That is how public blockchains work, and using one
          is a choice to be visible.
        </T>
      </Clause>

      <Clause title="Your IP address">
        <T>
          Our server sees your IP address, as every web server does. We use it
          for one thing: counting requests, so a single source cannot flood the
          upload or search endpoints.
        </T>
        <T>
          Those counters live in memory, hold a hashed-in-practice key and a
          count, expire within a minute, and are lost when the server restarts.
          They are never written to disk and never shared.
        </T>
      </Clause>

      <Clause title="What you upload">
        <T>
          Images and token details you submit are pinned to IPFS, a public
          distributed storage network, and referenced on the blockchain.
        </T>
        <T>
          <S>This is permanent and public.</S> We cannot delete something from
          IPFS once it is pinned, we cannot alter what is on-chain, and neither
          can you. Anything you upload should be treated as published forever.
        </T>
      </Clause>

      <Clause title="Your browser's own storage">
        <T>
          Your wallet software may store a connection preference in your
          browser&apos;s local storage so it can reconnect on your next visit.
          That stays on your device. We do not read it and it never reaches our
          server.
        </T>
      </Clause>

      <Clause title="Services we rely on">
        <T>
          Using this site means these companies process a request from you. Each
          has its own policy.
        </T>
        <List>
          <Item>
            <S>Railway</S> hosts the site and handles your connection.
          </Item>
          <Item>
            <S>Cloudflare</S> sits in front of it, serving files and filtering
            abuse.
          </Item>
          <Item>
            <S>Goldsky</S> indexes the blockchain for us. Your browser does not
            talk to it — our server does, once, on behalf of everyone.
          </Item>
          <Item>
            <S>Pinata</S> pins uploaded images to IPFS and serves them back.
          </Item>
          <Item>
            <S>Reown</S> provides the wallet connection dialog.
          </Item>
          <Item>
            <S>An Arc RPC provider</S> relays your transaction to the network.
          </Item>
        </List>
        <T>
          We do not sell data to anyone, because we do not have any to sell.
        </T>
      </Clause>

      <Clause title="Your rights">
        <T>
          Depending on where you live you may have rights to access, correct or
          delete personal data a company holds about you. We hold none, so there
          is nothing to hand over or erase.
        </T>
        <T>
          We also cannot erase blockchain or IPFS data. Nobody can. That is a
          property of those systems rather than a decision of ours, and it is
          worth understanding before you publish anything to them.
        </T>
      </Clause>

      <Clause title="Children">
        <T>
          This site is not for anyone under 18, and we do not knowingly collect
          anything from them.
        </T>
      </Clause>

      <Clause title="Changes">
        <T>
          If this changes, the date at the top changes with it. If we ever start
          collecting something — analytics, for example — this page will say so
          before we do.
        </T>
      </Clause>

      <Clause title="Contact">
        <T>
          Reach us at <a href="https://x.com/Aromadotmoney" target="_blank" rel="noreferrer" className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink-2">@Aromadotmoney</a>.
        </T>
      </Clause>
    </LegalPage>
  );
}
