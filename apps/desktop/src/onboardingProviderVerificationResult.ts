import type {
  DesktopModelProvider,
  DesktopOnboardingProviderFailureKind,
  DesktopOnboardingProviderVerificationResult,
} from "./contracts.js";

const FAILURE_MESSAGES: Record<DesktopOnboardingProviderFailureKind, string> = {
  invalid_credential: "The API key was not accepted. Check it and try again.",
  provider_rejected:
    "The provider rejected the verification request. Check its status and try again.",
  timeout:
    "The provider did not respond before the verification timeout. Try again.",
  unreachable:
    "Kestrel could not reach the provider endpoint. Check the endpoint and network, then retry.",
  model_unavailable:
    "The selected model is not available from this provider. Choose another model and retry.",
  secure_storage_unavailable:
    "Kestrel can’t write to the macOS Keychain from this launch. If the login keychain is locked, unlock it and retry. If Kestrel was opened by a test or automation tool, quit it and open the app from Finder.",
};

export function createDesktopOnboardingProviderFailure(
  kind: DesktopOnboardingProviderFailureKind,
): DesktopOnboardingProviderVerificationResult {
  return { ok: false, failure: { kind, message: FAILURE_MESSAGES[kind] } };
}

export function canReuseDesktopOnboardingProviderVerification(input: {
  requestedProvider: DesktopModelProvider;
  requestedModel: string;
  activeProvider: DesktopModelProvider;
  activeModel: string | undefined;
  credentialConfigured: boolean;
  verificationPresent: boolean;
}): boolean {
  return (
    input.credentialConfigured &&
    input.verificationPresent &&
    input.requestedProvider === input.activeProvider &&
    input.requestedModel === input.activeModel
  );
}
