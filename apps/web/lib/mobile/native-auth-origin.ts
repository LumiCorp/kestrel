export function withExpoOrigin(request: Request): Request {
  if (request.headers.has("origin")) {
    return request;
  }

  const expoOrigin = request.headers.get("expo-origin");
  if (!expoOrigin) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("origin", expoOrigin);

  return new Request(request, { headers });
}
