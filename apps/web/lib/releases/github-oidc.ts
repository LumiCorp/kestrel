import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import { z } from "zod";

const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_ACTIONS_JWKS = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`;
const GITHUB_ACTIONS_AUDIENCE = "kestrel-one-release-publisher";
const GITHUB_REPOSITORY = "LumiCorp/kestrel";
const GITHUB_REF = "refs/heads/main";
export const RELEASE_PUBLICATION_WORKFLOW_REF =
  "LumiCorp/kestrel/.github/workflows/fly-image-release.yml@refs/heads/main";
export const RELEASE_PREPARATION_WORKFLOW_REF =
  "LumiCorp/kestrel/.github/workflows/prepare-release-candidate.yml@refs/heads/main";

const jwtHeaderSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().trim().min(1),
  typ: z.string().optional(),
});

const jwtClaimsSchema = z.object({
  iss: z.literal(GITHUB_ACTIONS_ISSUER),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  nbf: z.number().int().optional(),
  repository: z.literal(GITHUB_REPOSITORY),
  ref: z.literal(GITHUB_REF),
  workflow_ref: z.string().trim().min(1),
  run_id: z.string().regex(/^\d+$/u),
  run_attempt: z.string().regex(/^[1-9]\d*$/u),
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  sub: z.string().trim().min(1),
});

const jwksSchema = z.object({
  keys: z.array(
    z
      .object({
        kty: z.literal("RSA"),
        kid: z.string().trim().min(1),
        n: z.string().trim().min(1),
        e: z.string().trim().min(1),
        alg: z.string().optional(),
        use: z.string().optional(),
      })
      .passthrough(),
  ),
});

type GithubActionsOidcClaims = z.infer<typeof jwtClaimsSchema>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function verifyGithubActionsReleaseToken(input: {
  token: string;
  expectedSha: string;
  fetchImpl?: FetchImplementation;
  now?: Date;
  expectedWorkflowRef?:
    | typeof RELEASE_PUBLICATION_WORKFLOW_REF
    | typeof RELEASE_PREPARATION_WORKFLOW_REF;
}): Promise<GithubActionsOidcClaims> {
  const parts = input.token.split(".");
  if (parts.length !== 3)
    throw new Error("GitHub Actions OIDC token is invalid.");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = jwtHeaderSchema.parse(parseJwtPart(encodedHeader));
  const claims = jwtClaimsSchema.parse(parseJwtPart(encodedClaims));
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (claims.exp <= nowSeconds || (claims.nbf ?? nowSeconds) > nowSeconds) {
    throw new Error("GitHub Actions OIDC token is not currently valid.");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(GITHUB_ACTIONS_AUDIENCE)) {
    throw new Error("GitHub Actions OIDC token has the wrong audience.");
  }
  if (claims.sha !== input.expectedSha) {
    throw new Error(
      "GitHub Actions OIDC token SHA does not match the release.",
    );
  }
  if (
    claims.workflow_ref !==
    (input.expectedWorkflowRef ?? RELEASE_PUBLICATION_WORKFLOW_REF)
  ) {
    throw new Error("GitHub Actions OIDC token has the wrong workflow.");
  }

  const response = await (input.fetchImpl ?? fetch)(GITHUB_ACTIONS_JWKS, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("GitHub Actions OIDC signing keys are unavailable.");
  }
  const jwks = jwksSchema.parse(await response.json());
  const signingKey = jwks.keys.find(
    (candidate) => candidate.kid === header.kid,
  );
  if (!signingKey) {
    throw new Error("GitHub Actions OIDC signing key is unknown.");
  }
  const verified = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    createPublicKey({ key: signingKey as JsonWebKey, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!verified) throw new Error("GitHub Actions OIDC signature is invalid.");
  return claims;
}

function parseJwtPart(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("GitHub Actions OIDC token is invalid.");
  }
}
