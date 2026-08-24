#!/usr/bin/env node

import { createServer } from "node:http";

const port = Number.parseInt(process.env.KESTREL_QUALIFICATION_MODEL_PORT ?? "43191", 10);
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    messages?: Array<{ content?: unknown }>;
    tools?: Array<{ function?: { name?: string } }>;
    stream?: boolean;
  };
  const serialized = JSON.stringify(body.messages ?? []);
  const toolName = body.tools?.find((tool) => tool.function?.name === "code_execute")?.function?.name;
  const mode = qualificationMode(serialized);
  const alreadyCalled = serialized.includes(`call_qualification_${mode}`);
  const toolCall = toolName && mode !== "final" && !alreadyCalled
    ? {
        id: `call_qualification_${mode}`,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(qualificationArguments(mode)),
        },
      }
    : {
        id: "call_qualification_finalize",
        type: "function",
        function: {
          name: "kestrel_finalize",
          arguments: JSON.stringify({
            status: "goal_satisfied",
            message: `qualification ${mode} complete`,
            assistantProgress: "qualification complete",
          }),
        },
      };
  const payload = {
    model: "qualification/deterministic",
    choices: [{ message: { content: null, tool_calls: [toolCall] } }],
  };
  response.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
  if (body.stream) {
    response.end(`data: ${JSON.stringify({ model: payload.model, choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] })}\n\ndata: [DONE]\n\n`);
  } else {
    response.end(JSON.stringify(payload));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ type: "qualification.model.started", port })}\n`);
});

function qualificationMode(serialized: string): string {
  for (const mode of ["selected-unused", "capability-free", "cancel", "timeout", "expiry", "reflect-secret", "concurrency"]) {
    if (serialized.includes(`qualification ${mode}`)) return mode;
  }
  return serialized.includes("qualification") ? "provider-used" : "final";
}

function qualificationArguments(mode: string): Record<string, unknown> {
  if (mode === "capability-free") {
    return { language: "javascript", code: "console.log('capability-free')" };
  }
  if (mode === "selected-unused") {
    return {
      language: "javascript",
      code: "console.log('selected capability intentionally unused')",
      capability: { version: 2, capabilityId: "tavily.search.read", operation: "search", input: { query: "unused", maxResults: 1 } },
    };
  }
  const query = mode === "cancel" || mode === "timeout" || mode === "expiry"
    ? `qualification-block-${mode}`
    : mode === "reflect-secret" ? "qualification-reflect-secret" : `qualification-${mode}`;
  return {
    language: "javascript",
    code: `(async()=>{const probes=['https://example.com','http://127.0.0.1:80','http://10.255.255.1:80','http://169.254.169.254/latest/meta-data/'];for(const url of probes){try{const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(500)});console.log('DIRECT_NETWORK_UNEXPECTED:'+JSON.stringify({url,status:response.status,finalUrl:response.url,type:response.type,redirected:response.redirected}))}catch(error){console.log('DIRECT_NETWORK_BLOCKED:'+JSON.stringify({url,error:error instanceof Error?error.name:'unknown'}))}}const r=await fetch('http://127.0.0.1:43127/v1/capability',{method:'POST',body:JSON.stringify({operation:'search',destination:'api.tavily.com',input:{query:${JSON.stringify(query)},maxResults:1}})});console.log(JSON.stringify(await r.json()))})()`,
    capability: { version: 2, capabilityId: "tavily.search.read", operation: "search", input: { query, maxResults: 1 } },
  };
}

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
