"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/chatbot/icons";
import { SidebarHistory } from "@/components/chatbot/sidebar-history";
import { SidebarUserNav } from "@/components/chatbot/sidebar-user-nav";
import { Button } from "@/components/chatbot/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/chatbot/ui/sidebar";
import type { Session } from "@/lib/auth-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function AppSidebar({
  isAdmin,
  session,
}: {
  isAdmin: boolean;
  session: Session | null;
}) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const hasUser = Boolean(session?.user);

  return (
    <Sidebar className="group-data-[side=left]:border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <div className="flex flex-row items-center justify-between">
            <Link
              className="flex flex-row items-center gap-3"
              href="/threads"
              onClick={() => {
                setOpenMobile(false);
              }}
            >
              <span className="cursor-pointer rounded-md px-2 font-semibold text-lg hover:bg-muted">
                Kestrel One
              </span>
            </Link>
            <div className="flex flex-row gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="h-8 p-1 md:h-fit md:p-2"
                    onClick={() => {
                      setOpenMobile(false);
                      router.push("/threads/new");
                    }}
                    type="button"
                    variant="ghost"
                  >
                    <PlusIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent align="end" className="hidden md:block">
                  New Thread
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {hasUser ? (
          <SidebarMenu className="px-2 pb-2">
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/knowledge">Knowledge</Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/dashboard/user">Account</Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {isAdmin ? (
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link href="/admin/agent">Admin</Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        ) : null}
        <SidebarHistory session={session} />
      </SidebarContent>
      <SidebarFooter>
        {session && <SidebarUserNav session={session} />}
      </SidebarFooter>
    </Sidebar>
  );
}
