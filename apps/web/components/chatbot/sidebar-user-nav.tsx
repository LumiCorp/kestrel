"use client";

import { ChevronUp, Palette } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/chatbot/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/chatbot/ui/sidebar";
import { signOut, useSession } from "@/lib/auth-client";
import type { Session } from "@/lib/auth-types";
import { guestRegex } from "@/lib/constants";
import { toast } from "./toast";

export function SidebarUserNav({ session }: { session: Session }) {
  const router = useRouter();
  const { data } = useSession();
  const currentSession = data || session;

  const isGuest = guestRegex.test(currentSession?.user?.email ?? "");

  const handleSignOut = async () => {
    try {
      await signOut({
        fetchOptions: {
          onSuccess: () => {
            router.push("/");
          },
        },
      });
    } catch {
      toast({
        type: "error",
        description: "Unable to sign out. Please try again.",
      });
    }
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="h-10 bg-background data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              data-testid="user-nav-button"
            >
              <Image
                alt={currentSession?.user?.email ?? "User Avatar"}
                className="rounded-full"
                height={24}
                src={`https://avatar.vercel.sh/${
                  currentSession?.user?.email ?? "guest"
                }`}
                width={24}
              />
              <span className="truncate" data-testid="user-email">
                {isGuest ? "Guest" : currentSession?.user?.email}
              </span>
              <ChevronUp className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width)"
            data-testid="user-nav-menu"
            side="top"
          >
            <DropdownMenuItem
              className="cursor-pointer"
              data-testid="user-nav-item-theme"
              onSelect={() => router.push("/settings/appearance")}
            >
              <Palette className="size-4" />
              Appearance
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="w-full cursor-pointer"
              data-testid="user-nav-item-auth"
              onClick={() => {
                if (isGuest) {
                  router.push("/sign-in");
                  return;
                }

                handleSignOut();
              }}
            >
              {isGuest ? "Login to your account" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
