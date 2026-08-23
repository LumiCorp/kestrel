import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const evidencePath = process.env.KESTREL_TEST_SANDBOX_CAPABILITY_EVIDENCE;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url !== "https://api.tavily.com/search") {
    return await originalFetch(input, init);
  }

  const authorization = new Headers(init?.headers).get("authorization");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  if (evidencePath !== undefined) {
    appendFileSync(evidencePath, `${JSON.stringify({
      url,
      method: init?.method,
      authorizationPresent: authorization !== null,
      authorizationScheme: authorization?.split(" ", 1)[0],
      query: body.query,
      maxResults: body.max_results,
      pid: process.pid,
    })}\n`, "utf8");
  }

  return new Response(JSON.stringify({
    results: [{
      title: "Isolated provider fixture",
      url: "https://example.test/kestrel",
      content: "Deterministic sandbox capability result.",
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
