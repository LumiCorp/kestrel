import {
  ensureReleaseControlSchema,
  resolveReleaseControlBootstrapConfiguration,
} from "../lib/releases/release-control-schema-bootstrap";

await ensureReleaseControlSchema(
  resolveReleaseControlBootstrapConfiguration(process.env),
);
