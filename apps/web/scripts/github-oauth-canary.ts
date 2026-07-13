type GithubConnectionResponse = {
  oauthConfigured?: boolean;
  linked?: boolean;
  connection?: {
    status?: string;
    providerLogin?: string | null;
  } | null;
  error?: unknown;
};

export {};

type GithubRepositoriesResponse = {
  repositories?: Array<{
    resource?: { label?: string };
    canPull?: boolean;
    canPush?: boolean;
  }>;
  error?: unknown;
};

const baseUrl = requiredUrl("KESTREL_ONE_CANARY_URL");
const cookie = required("KESTREL_ONE_CANARY_COOKIE");
const repository = required("KESTREL_ONE_CANARY_REPOSITORY");

const initial = await request<GithubConnectionResponse>(
  "/api/integrations/github"
);
assert(initial.oauthConfigured === true, "GitHub OAuth is not configured.");
assert(initial.linked === true, "The canary user has not linked GitHub.");

const synchronized = await request<{ repositoryCount?: number; error?: unknown }>(
  "/api/integrations/github/sync",
  { method: "POST" }
);
assert(
  typeof synchronized.repositoryCount === "number" &&
    synchronized.repositoryCount > 0,
  "GitHub returned no repositories for the linked user."
);

const connectionStatus = await request<GithubConnectionResponse>(
  "/api/integrations/github"
);
assert(
  connectionStatus.connection?.status === "connected",
  "The linked GitHub identity was not connected to the active organization."
);
assert(
  Boolean(connectionStatus.connection.providerLogin),
  "The synchronized GitHub identity has no provider login."
);

const repositories = await request<GithubRepositoriesResponse>(
  "/api/integrations/github/repositories"
);
const selected = repositories.repositories?.find(
  (candidate) => candidate.resource?.label === repository
);
assert(Boolean(selected), `GitHub repository ${repository} is not selectable.`);
assert(selected?.canPull === true, `${repository} does not allow pull access.`);
assert(selected?.canPush === true, `${repository} does not allow push access.`);

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      providerLogin: connectionStatus.connection.providerLogin,
      repository,
      repositoryCount: synchronized.repositoryCount,
      proofs: [
        "github_oauth_configured",
        "user_identity_linked",
        "organization_connection_synchronized",
        "repository_selectable",
        "repository_pull_allowed",
        "repository_push_allowed",
      ],
    },
    null,
    2
  ) + "\n"
);

async function request<T>(pathname: string, init: RequestInit = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...init,
    headers: {
      ...init.headers,
      accept: "application/json",
      cookie,
      origin: baseUrl.origin,
    },
    redirect: "manual",
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} returned non-JSON status ${response.status}.`
    );
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`
    );
  }
  return payload as T;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredUrl(name: string) {
  const url = new URL(required(name));
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use HTTPS outside local development.`);
  }
  return url;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
