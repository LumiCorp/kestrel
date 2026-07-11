import "./globals.css";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider } from "@/components/theme-provider";
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
        <link href="/favicon/favicon.ico" rel="icon" sizes="any" />
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <WrapperWithQuery>{children}</WrapperWithQuery>
          <Toaster closeButton richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
