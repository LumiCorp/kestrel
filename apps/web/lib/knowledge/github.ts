import { Buffer } from "node:buffer";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

type GitHubAuth =
  | { type: "pat"; token: string }
  | { type: "app"; appId: string; privateKey: string };

function decodePrivateKey(rawKey: string) {
  const normalized = rawKey.replace(/\\n/g, "\n").trim();
  if (normalized.includes("BEGIN")) {
    return normalized;
  }

  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
    if (decoded.includes("BEGIN")) {
      return decoded;
    }
  } catch {}

  return normalized;
}

export function resolveGitHubAuth(): GitHubAuth | null {
  if (process.env.GITHUB_TOKEN) {
    return { type: "pat", token: process.env.GITHUB_TOKEN };
  }

  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
    return {
      type: "app",
      appId: process.env.GITHUB_APP_ID,
      privateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY),
    };
  }

  return null;
}

function createAppOctokit(auth: Extract<GitHubAuth, { type: "app" }>) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey: auth.privateKey,
    },
  });
}

export async function getRepoToken(repoPath: string) {
  const auth = resolveGitHubAuth();
  if (!auth) {
    return;
  }

  if (auth.type === "pat") {
    return auth.token;
  }

  const [owner, repo] = repoPath.split("/");
  if (!(owner && repo)) {
    return;
  }

  const appOctokit = createAppOctokit(auth);
  try {
    const installation = await appOctokit.apps.getRepoInstallation({
      owner,
      repo,
    });
    const appAuth = createAppAuth({
      appId: auth.appId,
      privateKey: auth.privateKey,
    });
    const result = await appAuth({
      type: "installation",
      installationId: installation.data.id,
    });
    return result.token;
  } catch {
    return;
  }
}

export type GitHubRepository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch?: string;
  htmlUrl: string;
};

function mapRepository(repo: {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  html_url: string;
  owner?: { login?: string };
}) {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner?.login || repo.full_name.split("/")[0] || "",
    private: repo.private,
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
  } satisfies GitHubRepository;
}

export async function listConfiguredGitHubRepositories() {
  const auth = resolveGitHubAuth();
  if (!auth) {
    throw new Error("GitHub credentials not configured");
  }

  if (auth.type === "pat") {
    const octokit = new Octokit({ auth: auth.token });
    const repos = await octokit.paginate(
      octokit.rest.repos.listForAuthenticatedUser,
      {
        affiliation: "owner,collaborator,organization_member",
        per_page: 100,
        visibility: "all",
      }
    );
    return repos
      .map(mapRepository)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  const appOctokit = createAppOctokit(auth);
  const installations = await appOctokit.paginate(
    appOctokit.rest.apps.listInstallations,
    {
      per_page: 100,
    }
  );

  const repositories: GitHubRepository[] = [];
  for (const installation of installations) {
    const appAuth = createAppAuth({
      appId: auth.appId,
      privateKey: auth.privateKey,
    });
    const token = await appAuth({
      type: "installation",
      installationId: installation.id,
    });
    const octokit = new Octokit({ auth: token.token });
    const repos = await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 }
    );
    repositories.push(...repos.map(mapRepository));
  }

  return Array.from(
    new Map(repositories.map((repo) => [repo.fullName, repo])).values()
  ).sort((a, b) => a.fullName.localeCompare(b.fullName));
}
