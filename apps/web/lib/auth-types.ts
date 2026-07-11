import type { Invitation as OrganizationInvitation } from "@/drizzle/schema";
import type { auth } from "./auth";

export type Session = typeof auth.$Infer.Session;

export type SerializedSessionRecord = {
  id: string;
  expiresAt: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
  activeOrganizationId?: string | null;
  impersonatedBy?: string | null;
};

export type ActiveOrganization = {
  id: string;
  name: string;
  slug?: string | null;
  logo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  members?: Array<{
    id: string;
    organizationId: string;
    role: "owner" | "admin" | "member";
    userId: string;
    createdAt: string;
    user: {
      id: string;
      name: string;
      email: string;
      image?: string | null;
    };
  }>;
  invitations?: Array<{
    id: string;
    email: string;
    role: "admin" | "member";
    status: string;
    expiresAt: string;
    createdAt: string;
    organizationId: string;
    inviterId: string;
  }>;
};

export type OrganizationSnapshot = Pick<
  ActiveOrganization,
  "id" | "name" | "slug" | "logo"
>;

export type Invitation = OrganizationInvitation;
