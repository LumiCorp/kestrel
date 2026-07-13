FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mcp-service/package.json apps/mcp-service/package.json
COPY packages/environment-auth/package.json packages/environment-auth/package.json
COPY packages/mcp-security/package.json packages/mcp-security/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile --filter @kestrel/mcp-service...
COPY apps/mcp-service apps/mcp-service
COPY packages/environment-auth packages/environment-auth
COPY packages/mcp-security packages/mcp-security
COPY packages/protocol packages/protocol
RUN pnpm --filter @kestrel/mcp-service build

FROM node:22-bookworm-slim
WORKDIR /app/apps/mcp-service
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/mcp-service /app/apps/mcp-service
COPY --from=build /app/packages/environment-auth /app/packages/environment-auth
COPY --from=build /app/packages/mcp-security /app/packages/mcp-security
ENV NODE_ENV=production PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
