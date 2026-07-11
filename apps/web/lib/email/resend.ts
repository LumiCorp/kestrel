import { Resend } from "resend";

// Only initialize Resend if API key is provided
const resendApiKey = process.env.RESEND_API_KEY;

export const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const isEmailEnabled = () =>
  !!resendApiKey && !!process.env.BETTER_AUTH_EMAIL;
