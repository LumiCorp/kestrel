import "./globals.css";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { BrandFaviconSync } from "@/components/brand";
import { ThemeProvider } from "@/components/theme-provider";
import { PaletteBootstrap } from "@/components/palette-bootstrap";
import { PaletteProvider } from "@/components/palette-provider";
import { Toaster } from "@/components/ui/sonner";
import { WrapperWithQuery } from "@/components/wrapper";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: {
    template: "%s | Kestrel One",
    default: "Kestrel One",
  },
  description: "Unified auth, chat, knowledge, and admin.",
  metadataBase: new URL("https://kestrel.one"),
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          data-kestrel-favicon="system-light"
          href="/brand/favicon-light.ico"
          media="(prefers-color-scheme: light)"
          rel="icon"
          sizes="any"
          type="image/x-icon"
        />
        <link
          data-kestrel-favicon="system-dark"
          href="/brand/favicon-dark.ico"
          media="(prefers-color-scheme: dark)"
          rel="icon"
          sizes="any"
          type="image/x-icon"
        />
        <link
          href="/brand/favicon-light-180.png"
          rel="apple-touch-icon"
          sizes="180x180"
        />
        <PaletteBootstrap />
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <BrandFaviconSync />
          <PaletteProvider>
            <WrapperWithQuery>{children}</WrapperWithQuery>
            <Toaster closeButton richColors />
          </PaletteProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
