import type { Metadata } from "next";
import { Fraunces, Instrument_Sans } from "next/font/google";

import { SkipLink } from "@/components/SkipLink";
import { siteMetadata } from "@/lib/metadata";

import "./globals.css";

const displayFont = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

const bodyFont = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = siteMetadata;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <SkipLink />
        {children}
      </body>
    </html>
  );
}
