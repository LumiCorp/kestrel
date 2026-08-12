export const SIGNUP_ONBOARDING_PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
] as const;

export type SignupOnboardingProvider =
  (typeof SIGNUP_ONBOARDING_PROVIDERS)[number];

export function isSignupOnboardingProvider(
  provider: string,
): provider is SignupOnboardingProvider {
  return SIGNUP_ONBOARDING_PROVIDERS.some(
    (candidate) => candidate === provider,
  );
}
