"use client";

import { ArrowUpRight, CheckCircle2, Laptop, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

const products = {
  desktop: {
    label: "Kestrel Desktop",
    icon: Laptop,
    image: "/product/desktop/checkout-result.png",
    imageAlt:
      "Kestrel Desktop showing a completed checkout fix, regression coverage, and passing tests",
    heading: "Work locally, with the project in front of you.",
    description:
      "Open a repository, folder, research collection, or blank project. Kestrel can inspect the material, use approved tools, produce artifacts, and keep the session ready for your next return.",
    points: [
      "Local projects and model choice",
      "Visible runtime and tool state",
      "Durable sessions and artifacts",
    ],
    href: "https://docs.kestrelagents.dev/desktop/install",
    action: "Download Desktop Beta",
  },
  one: {
    label: "Kestrel One",
    icon: Users,
    image: "/product/kestrel-one/knowledge.png",
    imageAlt:
      "Kestrel One Knowledge workspace for adding shared files and sources",
    heading: "Give the team one source of context.",
    description:
      "Connect files and shared sources once, then make that context available to the people, Projects, and Threads that need it.",
    points: [
      "Shared Knowledge and files",
      "Durable Projects and Threads",
      "Approved Apps and execution Environments",
    ],
    href: "https://docs.kestrelagents.dev/kestrel-one/getting-started",
    action: "Explore Kestrel One Beta",
  },
} as const;

export function ProductShowcase() {
  return (
    <Tabs className="gap-8" defaultValue="desktop">
      <TabsList
        aria-label="Choose a Kestrel product"
        className="h-11 w-full max-w-md self-center p-1"
      >
        <TabsTrigger className="gap-2" value="desktop">
          <Laptop />
          Desktop
        </TabsTrigger>
        <TabsTrigger className="gap-2" value="one">
          <Users />
          Kestrel One
        </TabsTrigger>
      </TabsList>

      {Object.entries(products).map(([key, product]) => (
        <TabsContent key={key} value={key}>
          <article className="grid items-center gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)] lg:gap-12">
            <div className="overflow-hidden rounded-xl border bg-card shadow-elevation-light">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <product.icon className="size-4 text-primary" />
                  {product.label}
                </div>
                <Badge variant="outline">Beta</Badge>
              </div>
              <div className="relative aspect-[1.44/1] bg-surface">
                <Image
                  alt={product.imageAlt}
                  className="object-contain object-top"
                  fill
                  sizes="(min-width: 1024px) 760px, 100vw"
                  src={product.image}
                />
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.18em]">
                  {product.label} · Beta
                </p>
                <h3 className="text-balance font-semibold text-3xl tracking-tight">
                  {product.heading}
                </h3>
                <p className="text-pretty text-base text-muted-foreground leading-7">
                  {product.description}
                </p>
              </div>

              <ul className="space-y-3">
                {product.points.map((point) => (
                  <li className="flex items-start gap-3 text-sm" key={point}>
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              <Button asChild variant="outline">
                <Link href={product.href}>
                  {product.action}
                  <ArrowUpRight />
                </Link>
              </Button>
            </div>
          </article>
        </TabsContent>
      ))}
    </Tabs>
  );
}
