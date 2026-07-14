export async function withExpoOrigin(request: Request): Promise<Request> {
  if (request.headers.has("origin")) {
    return request;
  }

  const expoOrigin = request.headers.get("expo-origin");
  if (!expoOrigin) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("origin", expoOrigin);

  const body = request.body === null ? undefined : await request.arrayBuffer();

  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  });
}
