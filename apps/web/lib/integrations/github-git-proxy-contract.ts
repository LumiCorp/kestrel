export function isGitUploadPackRequest(input: {
  method: string;
  path: string[];
  service: string | null;
}) {
  const isDiscovery =
    input.method === "GET" &&
    input.path.length === 2 &&
    input.path[0] === "info" &&
    input.path[1] === "refs" &&
    input.service === "git-upload-pack";
  const isUpload =
    input.method === "POST" &&
    input.path.length === 1 &&
    input.path[0] === "git-upload-pack";
  return isDiscovery || isUpload;
}

export function githubRepositoryUpstreamUrl(input: {
  repository: string;
  path: string[];
  search: string;
}) {
  const repositoryPath = input.repository
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = new URL(
    `https://github.com/${repositoryPath}.git/${input.path.join("/")}`
  );
  url.search = input.search;
  return url;
}
