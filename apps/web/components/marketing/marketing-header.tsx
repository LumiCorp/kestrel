"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BrandMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const navigation = [
  { href: "#desktop", label: "Desktop" },
  { href: "#kestrel-one", label: "Kestrel One" },
  { href: "#developers", label: "Developers" },
  { href: "https://docs.kestrelagents.dev", label: "Docs" },
  { href: "https://www.lumicorp.ai", label: "Lumi" },
] as const;

export function MarketingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-border/80 border-b bg-background/92 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          aria-label="Kestrel home"
          className="flex items-center gap-2.5 rounded-md font-semibold text-lg tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          href="/"
        >
          <BrandMark decorative size={28} />
          <span>Kestrel</span>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="hidden items-center gap-1 lg:flex"
        >
          {navigation.map((item) => (
            <Button asChild key={item.href} variant="ghost">
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Button asChild variant="ghost">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild>
            <Link href="https://docs.kestrelagents.dev/desktop/install">
              Download Beta
            </Link>
          </Button>
        </div>

        <Sheet onOpenChange={setMenuOpen} open={menuOpen}>
          <SheetTrigger asChild>
            <Button
              aria-label="Open navigation"
              className="size-11 lg:hidden"
              size="icon"
              variant="outline"
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent className="w-[min(22rem,88vw)]">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2.5">
                <BrandMark decorative size={26} />
                Kestrel
              </SheetTitle>
              <SheetDescription>
                Choose how you want to work with Kestrel.
              </SheetDescription>
            </SheetHeader>
            <nav
              aria-label="Mobile navigation"
              className="flex flex-col gap-1 px-4"
            >
              {navigation.map((item) => (
                <SheetClose asChild key={item.href}>
                  <Button
                    asChild
                    className="h-11 justify-start"
                    variant="ghost"
                  >
                    <Link href={item.href}>{item.label}</Link>
                  </Button>
                </SheetClose>
              ))}
            </nav>
            <div className="mt-auto grid gap-2 border-t p-4">
              <SheetClose asChild>
                <Button asChild variant="outline">
                  <Link href="/sign-in">Sign in</Link>
                </Button>
              </SheetClose>
              <SheetClose asChild>
                <Button asChild>
                  <Link href="https://docs.kestrelagents.dev/desktop/install">
                    Download Desktop Beta
                  </Link>
                </Button>
              </SheetClose>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
