import Link from "next/link";

/**
 * Shared shell for the terms and the privacy policy.
 *
 * These are drafts, and the file says so where a reader will see it. They
 * describe what this software actually does — the data audit behind the
 * privacy policy was done against the code, not assumed — but describing
 * behaviour accurately is not the same as being enforceable, and the
 * difference matters once real money is involved.
 */

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[720px] px-4 py-6 pb-16">
      <Link
        href="/"
        className="-my-2 inline-block py-2 text-[12px] text-ink-3 transition-colors hover:text-ink-2"
      >
        ← Board
      </Link>

      <h1 className="mt-4 text-[26px] font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      <p className="num mt-1 text-[12px] text-ink-3">Last updated {updated}</p>

      <div className="mt-8 space-y-8">{children}</div>

      <p className="mt-12 border-t border-line pt-6 text-[12.5px] leading-relaxed text-ink-3">
        This is a draft written to describe how Aroma actually works. It has not
        been reviewed by a lawyer. If you are relying on it for anything that
        matters, do not.
      </p>
    </div>
  );
}

export function Clause({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-2.5">{children}</div>
    </section>
  );
}

export const T = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[14px] leading-[1.65] text-ink-2">{children}</p>
);

export const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="space-y-2 text-[14px] leading-[1.65] text-ink-2">{children}</ul>
);

export const Item = ({ children }: { children: React.ReactNode }) => (
  <li className="flex gap-2">
    <span className="text-ink-3">·</span>
    <span className="min-w-0">{children}</span>
  </li>
);

export const S = ({ children }: { children: React.ReactNode }) => (
  <span className="text-ink">{children}</span>
);
