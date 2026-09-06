import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Web3Provider } from "@/components/web3-provider";
import { WalletProvider } from "@/components/wallet";
import { TestnetBanner } from "@/components/testnet-banner";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The origin every relative metadata URL is resolved against.
 *
 * Without this Next falls back to http://localhost:3000, and og:image
 * resolves to a localhost URL — which is fine locally and useless in
 * production: Telegram, X and every other unfurler fetches that address,
 * gets nothing, and shows the link with no picture. The failure is
 * invisible from inside the app, because the page itself renders fine.
 *
 * RAILWAY_PUBLIC_DOMAIN is injected by the platform, so a Railway deploy
 * gets this right with no configuration. NEXT_PUBLIC_SITE_URL overrides it
 * for anywhere else — a custom domain, most obviously, which is what this
 * should point at once one exists.
 */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Aroma — launch coins on Arc",
    template: "%s · Aroma",
  },
  description:
    "Launch and trade fixed-supply tokens on Arc, where USDC is the native gas token and every price is already a dollar.",

  icons: {
    icon: [
      { url: "/icon.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS ignores transparency and would put the wisp on white, so this
    // one is pre-composited on the brand background.
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },

  /**
   * Link previews.
   *
   * A launchpad gets shared as a link far more often than it gets typed
   * in, and until now an Aroma URL unfurled as a blank rectangle on X and
   * Discord — the one place the product is seen by people who have never
   * been to the site.
   */
  openGraph: {
    type: "website",
    siteName: "Aroma",
    title: "Aroma — launch coins on Arc",
    description:
      "Fixed-supply tokens on a bonding curve. Gas is USDC, so every price is already a dollar.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Aroma" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@Aromadotmoney",
    creator: "@Aromadotmoney",
    title: "Aroma — launch coins on Arc",
    description:
      "Fixed-supply tokens on a bonding curve. Gas is USDC, so every price is already a dollar.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <Web3Provider>
          <WalletProvider>
            <TestnetBanner />
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </WalletProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
