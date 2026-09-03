import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Web3Provider } from "@/components/web3-provider";
import { WalletProvider } from "@/components/wallet";
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

export const metadata: Metadata = {
  title: {
    default: "aram — launch coins on Arc",
    template: "%s · aram",
  },
  description:
    "Launch and trade fixed-supply tokens on Arc, where USDC is the native gas token and every price is already a dollar.",
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
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </WalletProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
