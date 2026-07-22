import { Resend } from "resend";
import type { ResolvedOrganizationEmailConfig } from "./organization-config";

export class OrganizationEmailDeliveryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Organization email delivery is unavailable.");
    this.name = "OrganizationEmailDeliveryError";
    this.code = code;
  }
}

function sender(config: ResolvedOrganizationEmailConfig) {
  return config.fromName
    ? `${config.fromName} <${config.fromEmail}>`
    : config.fromEmail;
}

export async function sendOrganizationEmail(input: {
  config: ResolvedOrganizationEmailConfig;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
}) {
  if (
    !input.config.enabled ||
    input.config.status !== "ready" ||
    !input.config.apiKey ||
    !input.config.fromEmail
  ) {
    throw new OrganizationEmailDeliveryError("EMAIL_NOT_CONFIGURED");
  }
  const resend = new Resend(input.config.apiKey);
  const { data, error } = await resend.emails.send(
    {
      from: sender(input.config),
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.config.replyTo ?? undefined,
    },
    { headers: { "Idempotency-Key": input.idempotencyKey } }
  );
  if (error || !data?.id) {
    throw new OrganizationEmailDeliveryError("EMAIL_PROVIDER_REJECTED");
  }
  return { id: data.id };
}

export async function sendOrganizationEmailTest(input: {
  config: ResolvedOrganizationEmailConfig;
  to: string;
}) {
  if (!(input.config.apiKey && input.config.fromEmail)) {
    throw new OrganizationEmailDeliveryError("EMAIL_NOT_CONFIGURED");
  }
  const resend = new Resend(input.config.apiKey);
  const { data, error } = await resend.emails.send(
    {
      from: sender(input.config),
      to: input.to,
      subject: "Kestrel One organization email test",
      text: "Your organization Resend integration is configured correctly.",
      html: "<p>Your organization Resend integration is configured correctly.</p>",
      replyTo: input.config.replyTo ?? undefined,
    },
    { headers: { "Idempotency-Key": `organization-email-test-${crypto.randomUUID()}` } }
  );
  if (error || !data?.id) {
    throw new OrganizationEmailDeliveryError("EMAIL_PROVIDER_REJECTED");
  }
  return { id: data.id };
}
