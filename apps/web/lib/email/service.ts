import type { ReactNode } from "react";
import { Resend } from "resend";
import { type ResolvedEmailConfig, resolveEmailConfig } from "./config";

export type TransactionalEmailKind =
  | "verification"
  | "password_reset"
  | "organization_invitation"
  | "two_factor_otp"
  | "admin_test";

export class EmailDeliveryError extends Error {
  readonly code: string;

  constructor(code = "EMAIL_DELIVERY_UNAVAILABLE") {
    super("Email delivery is temporarily unavailable.");
    this.name = "EmailDeliveryError";
    this.code = code;
  }
}

export type TransactionalEmail = {
  kind: TransactionalEmailKind;
  to: string;
  subject: string;
  html?: string;
  react?: ReactNode;
  idempotencyKey: string;
  developmentContent?: string;
};

type SendDependencies = {
  resolveConfig?: () => Promise<ResolvedEmailConfig>;
  sendWithResend?: typeof sendWithResend;
  environment?: string;
  logDevelopment?: (message: string) => void;
};

function sender(config: ResolvedEmailConfig) {
  return config.fromName
    ? `${config.fromName} <${config.fromEmail}>`
    : config.fromEmail;
}

async function sendWithResend(
  config: ResolvedEmailConfig,
  message: TransactionalEmail
) {
  if (!config.apiKey) {
    throw new EmailDeliveryError("EMAIL_CREDENTIAL_MISSING");
  }
  const resend = new Resend(config.apiKey);
  const { data, error } = await resend.emails.send(
    {
      from: sender(config),
      to: message.to,
      subject: message.subject,
      replyTo: config.replyTo ?? undefined,
      html: message.html,
      react: message.react,
    },
    { headers: { "Idempotency-Key": message.idempotencyKey } }
  );
  if (error || !data?.id) {
    throw new EmailDeliveryError("EMAIL_PROVIDER_REJECTED");
  }
  return { id: data.id };
}

export async function deliverTransactionalEmail(
  message: TransactionalEmail,
  dependencies: SendDependencies = {}
) {
  const environment = dependencies.environment ?? process.env.NODE_ENV;
  const send = dependencies.sendWithResend ?? sendWithResend;

  try {
    const config = await (dependencies.resolveConfig ?? resolveEmailConfig)();
    const hasDeliveryAuthority = config.persisted
      ? config.status === "ready"
      : config.credentialSource === "environment";
    if (
      !(
        config.enabled &&
        config.apiKey &&
        config.fromEmail &&
        hasDeliveryAuthority
      )
    ) {
      throw new EmailDeliveryError("EMAIL_NOT_CONFIGURED");
    }
    return await send(config, message);
  } catch (error) {
    if (environment === "development" && message.developmentContent) {
      (dependencies.logDevelopment ?? console.info)(
        `[email:development] ${message.kind} to ${message.to}: ${message.developmentContent}`
      );
      return { id: `development:${message.kind}` };
    }
    if (error instanceof EmailDeliveryError) {
      throw error;
    }
    throw new EmailDeliveryError();
  }
}

export async function sendEmailIntegrationTest(
  to: string,
  dependencies: SendDependencies = {}
) {
  const config = await (dependencies.resolveConfig ?? resolveEmailConfig)();
  if (!(config.apiKey && config.fromEmail)) {
    throw new EmailDeliveryError("EMAIL_NOT_CONFIGURED");
  }
  return (dependencies.sendWithResend ?? sendWithResend)(config, {
    kind: "admin_test",
    to,
    subject: "Kestrel One email delivery test",
    html: "<p>Your Kestrel One Resend integration is configured correctly.</p>",
    idempotencyKey: `admin-test-${crypto.randomUUID()}`,
  });
}
