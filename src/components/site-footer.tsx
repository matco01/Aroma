import Link from "next/link";
import { ARC_TESTNET, CURVE } from "@/lib/arc";

/**
 * Pons puts its trust model in plain language in the footer instead of a
 * marketing section, and it does more for credibility than any hero could.
 * Same move here — state exactly what the protocol does and does not do.
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto max-w-[1400px] px-4 py-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="max-w-xs">
            <div className="mb-2 text-[13px] font-semibold text-ink">aram</div>
            <p className="text-[12px] leading-relaxed text-ink-2">
              Launch and trade fixed-supply tokens on Arc. Your wallet signs and
              submits every transaction. aram never takes custody of your funds.
            </p>
          </div>

          <FooterCol title="Protocol">
            <FooterLink href="/">Board</FooterLink>
            <FooterLink href="/create">Launch a coin</FooterLink>
            <FooterRow label="Trade fee" value={`${CURVE.tradeFeeBps / 100}%`} />
            <FooterRow
              label="To creator"
              value={`${CURVE.creatorFeeShareBps / 100}% of fees`}
            />
            <FooterRow label="Creation fee" value="Free" />
          </FooterCol>

          <FooterCol title="Network">
            <FooterRow label="Chain" value={ARC_TESTNET.name} />
            <FooterRow label="Chain ID" value={String(ARC_TESTNET.id)} />
            <FooterRow label="Gas token" value="USDC" />
            <FooterExternal href={ARC_TESTNET.explorer}>Arcscan</FooterExternal>
            <FooterExternal href={ARC_TESTNET.faucet}>Testnet faucet</FooterExternal>
          </FooterCol>

          <FooterCol title="Legal">
            <FooterLink href="/">Terms of use</FooterLink>
            <FooterLink href="/">Privacy policy</FooterLink>
          </FooterCol>
        </div>

        <p className="mt-8 border-t border-line pt-5 text-[11.5px] leading-relaxed text-ink-3">
          Transactions are submitted through your wallet and are irreversible
          once final. Tokens launched here are created by anonymous third
          parties, carry no rights or claims, and can lose all value. Nothing on
          this site is investment advice. Currently running against{" "}
          {ARC_TESTNET.name} — balances are test funds with no monetary value.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="label mb-2.5">{title}</div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="text-[12px] text-ink-2 transition-colors hover:text-ink"
      >
        {children}
      </Link>
    </li>
  );
}

function FooterExternal({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-[12px] text-ink-2 transition-colors hover:text-ink"
      >
        {children}
        <span className="ml-0.5 text-ink-3">↗</span>
      </a>
    </li>
  );
}

function FooterRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-baseline justify-between gap-4">
      <span className="text-[12px] text-ink-2">{label}</span>
      <span className="num text-[11.5px] text-ink-3">{value}</span>
    </li>
  );
}
