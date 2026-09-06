import type { Metadata } from "next";
import { LegalPage, Clause, T, List, Item, S } from "@/components/legal";
import { ARC_TESTNET, CURVE } from "@/lib/arc";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The terms you accept by using Aroma.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="6 September 2026">
      <Clause title="What Aroma is">
        <T>
          Aroma is an interface to a set of smart contracts on {ARC_TESTNET.name}.
          The contracts let anyone create a token and trade it against a bonding
          curve. We wrote the contracts and we run this website. That is the
          whole of what we do.
        </T>
        <T>
          Using this site means you accept these terms. If you do not, do not
          use it.
        </T>
      </Clause>

      <Clause title="We never hold your funds">
        <T>
          Aroma is non-custodial. Your wallet holds your assets, signs every
          transaction, and submits it. We cannot move your tokens, spend your
          balance, or sign anything on your behalf.
        </T>
        <T>
          This also means we cannot help you if something goes wrong. We cannot
          reverse a trade, recover a token sent to the wrong address, restore a
          lost key, or freeze anyone&apos;s funds. There is no function in the
          contracts that would let us, which you can verify yourself.
        </T>
      </Clause>

      <Clause title="Tokens here are made by strangers">
        <T>
          Anyone can launch a token. We do not review, approve, endorse, or
          verify any of them, and a token appearing on this site means only that
          somebody paid the gas to create it.
        </T>
        <List>
          <Item>
            <S>Names, tickers and pictures can be copied.</S> Two tokens can look
            identical. The contract address is the only thing that identifies
            one, and it is shown on every token&apos;s page.
          </Item>
          <Item>
            <S>Creators can sell whatever they hold,</S> at any time, without
            warning. Their holding is shown on the token&apos;s page.
          </Item>
          <Item>
            <S>Most tokens go to zero.</S> Treat every launch as likely
            worthless.
          </Item>
        </List>
        <T>
          A token launched here is not a security, a share, a deposit, or a claim
          on anything. It carries no rights and no promise from anyone.
        </T>
      </Clause>

      <Clause title="Nothing here is advice">
        <T>
          Nothing on this site is financial, investment, legal or tax advice.
          Charts, market caps, holder counts and every other figure are
          information, not a recommendation. We are not your broker, adviser or
          fiduciary.
        </T>
      </Clause>

      <Clause title="Trades are final">
        <T>
          Blockchain transactions cannot be undone. Once a trade is confirmed it
          is permanent, including one you made by mistake, at the wrong price, on
          the wrong token, or after being misled by someone.
        </T>
        <T>
          Prices move between the moment you sign and the moment your
          transaction lands. The slippage setting is your protection against
          that; setting it high enough removes the protection.
        </T>
      </Clause>

      <Clause title="Fees">
        <T>
          A {CURVE.tradeFeeBps / 100}% fee applies to every buy and sell.{" "}
          {CURVE.creatorFeeShareBps / 100}% of that goes to the token&apos;s
          creator and the rest to us. Launching is free. Creators may also
          enable a launch-window tax on early buys, which is disclosed on the
          token&apos;s page. Fees are enforced by the contracts and are the same
          for everyone.
        </T>
      </Clause>

      <Clause title="What you upload">
        <T>
          You keep ownership of images and text you submit. By submitting them
          you allow us to display them on this site, and you confirm you have the
          right to do so.
        </T>
        <T>
          Uploads are pinned to IPFS and the reference is written to the
          blockchain. Both are public and permanent. We cannot delete an image
          once it is pinned, and we cannot alter what is on-chain. Do not upload
          anything you might want removed.
        </T>
        <T>
          Do not upload material that is illegal, that infringes someone
          else&apos;s rights, or that impersonates a real person or organisation.
          We may remove content from this website, but that does not remove it
          from IPFS or the blockchain.
        </T>
      </Clause>

      <Clause title="How you may not use this">
        <List>
          <Item>Where using it would break the law that applies to you.</Item>
          <Item>
            To manipulate a market — wash trading, spoofing, coordinated pumps.
          </Item>
          <Item>
            To impersonate someone, or to launch a token that pretends to be
            associated with a person or company that has not agreed to it.
          </Item>
          <Item>
            To attack the site or the contracts, or to interfere with anyone
            else&apos;s use of them.
          </Item>
        </List>
        <T>
          You are responsible for your own compliance, including any tax you owe.
          We do not withhold or report anything.
        </T>
      </Clause>

      <Clause title="This is a test network">
        <T>
          Aroma currently runs against {ARC_TESTNET.name}. Balances there are
          test funds with no monetary value, obtained free from a faucet.
          Anything you buy is worth nothing, and test networks can be reset or
          discontinued without notice, which would destroy everything on them.
        </T>
      </Clause>

      <Clause title="No warranty">
        <T>
          This site and the contracts are provided as they are, with no
          warranty. We do not promise the site will be available, that the
          indexer will be current, that prices shown are accurate at the instant
          you act on them, or that the software is free of defects.
        </T>
        <T>
          Smart contracts can contain bugs. Ours have been tested but not
          audited by a third party. Assume risk accordingly.
        </T>
      </Clause>

      <Clause title="Limits on liability">
        <T>
          To the fullest extent the law allows, we are not liable for losses
          arising from your use of this site or the contracts — including
          trading losses, tokens that go to zero, transactions you did not
          intend, downtime, indexer lag, or the actions of anyone who launches a
          token here.
        </T>
      </Clause>

      <Clause title="Changes">
        <T>
          We may change these terms. The date at the top says when they last
          changed, and continuing to use the site after that means you accept
          the new version. Deployed contracts are immutable and are not affected
          by changes here.
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
