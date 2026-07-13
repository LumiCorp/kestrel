/**
 * Compatibility entrypoint for the Resend-backed email boundary.
 *
 * Provider clients are intentionally created from the dynamically resolved
 * platform configuration in service.ts; this module must not capture secrets
 * at process startup.
 */
export {
  deliverTransactionalEmail,
  sendEmailIntegrationTest,
} from "./service";
