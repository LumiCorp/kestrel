import type { Metadata } from "next";
import { Fraunces, Instrument_Sans } from "next/font/google";

import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site";

import "./globals.css";

const displayFont = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

const bodyFont = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: `%s · ${SITE_TITLE}`,
  },
  description: SITE_DESCRIPTION,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <a href="#app-main" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
