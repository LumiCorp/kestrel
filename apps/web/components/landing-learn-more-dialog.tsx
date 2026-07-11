"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const REQUEST_EMAIL = "hello@kestrel.one";

export function LandingLearnMoreDialog() {
  const [email, setEmail] = useState("");

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      toast.error("Enter your email.");
      return;
    }

    const subject = encodeURIComponent("Kestrel One request");
    const body = encodeURIComponent(`Email: ${trimmedEmail}`);

    window.location.href = `mailto:${REQUEST_EMAIL}?subject=${subject}&body=${body}`;
    toast.success("Opening email draft.");
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="inline-flex min-w-[10rem] items-center justify-center border border-border/80 border-dashed bg-background/80 px-5 py-3 font-medium font-mono text-[11px] text-foreground uppercase tracking-[0.24em] transition-colors duration-150 hover:border-primary/50 hover:bg-accent/40"
          type="button"
        >
          Learn More
        </button>
      </DialogTrigger>
      <DialogContent className="border border-border/80 border-dashed bg-background/95 p-6 backdrop-blur-sm sm:max-w-md">
        <DialogHeader className="space-y-3 text-left">
          <DialogTitle className="font-medium font-mono text-[11px] uppercase tracking-[0.28em]">
            Learn More
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm leading-6">
            Leave an email. We will open a request draft.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block space-y-2">
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.24em]">
              Email
            </span>
            <input
              autoComplete="email"
              className="h-11 w-full border border-border/80 border-dashed bg-background px-3 text-sm outline-none transition-colors focus:border-primary/60"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              type="email"
              value={email}
            />
          </label>

          <button
            className="hover:-translate-y-px inline-flex w-full items-center justify-center border border-foreground border-dashed bg-foreground px-5 py-3 font-medium font-mono text-[11px] text-background uppercase tracking-[0.24em] transition-transform duration-150 hover:bg-foreground/92"
            type="submit"
          >
            Request Access
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
