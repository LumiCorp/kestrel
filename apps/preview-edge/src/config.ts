export type PreviewEdgeConfig = {
  port: number;
  healthPort: number;
  controlPlaneUrl: string;
  serviceToken: string;
  hostSuffix: string;
};

export function readPreviewEdgeConfig(
  environment: NodeJS.ProcessEnv = process.env
): PreviewEdgeConfig {
  return {
    port: readPort(environment.PORT, "PORT", 8080),
    healthPort: readPort(environment.HEALTH_PORT, "HEALTH_PORT", 8081),
    controlPlaneUrl: readControlPlaneUrl(
      required(environment.KESTREL_CONTROL_PLANE_URL, "KESTREL_CONTROL_PLANE_URL")
    ),
    serviceToken: required(
      environment.KESTREL_PREVIEW_EDGE_SERVICE_TOKEN,
      "KESTREL_PREVIEW_EDGE_SERVICE_TOKEN"
    ),
    hostSuffix: readHostSuffix(
      required(
        environment.KESTREL_PREVIEW_HOST_SUFFIX,
        "KESTREL_PREVIEW_HOST_SUFFIX"
      )
    ),
  };
}

function readPort(value: string | undefined, name: string, fallback: number) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return parsed;
}

function readControlPlaneUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("KESTREL_CONTROL_PLANE_URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("KESTREL_CONTROL_PLANE_URL must be a valid HTTPS origin.");
  }
  return url.origin;
}

function readHostSuffix(value: string) {
  if (
    value !== value.toLowerCase() ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
      value
    )
  ) {
    throw new Error(
      "KESTREL_PREVIEW_HOST_SUFFIX must be a canonical lowercase DNS suffix."
    );
  }
  return value;
}

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
