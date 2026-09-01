FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/environment-router/package.json apps/environment-router/package.json
COPY packages/conversation/package.json packages/conversation/package.json
COPY packages/environment-auth/package.json packages/environment-auth/package.json
COPY packages/mcp-security/package.json packages/mcp-security/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile --filter @kestrel/environment-router...
COPY apps/environment-router apps/environment-router
COPY packages/conversation packages/conversation
COPY packages/environment-auth packages/environment-auth
COPY packages/mcp-security packages/mcp-security
COPY packages/protocol packages/protocol
RUN pnpm --filter @kestrel/environment-router build

FROM node:22-bookworm-slim
ARG KESTREL_BUILD_ID=unknown
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.version=$KESTREL_BUILD_ID
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/environment-router ./apps/environment-router
COPY --from=build /app/packages/conversation ./packages/conversation
COPY --from=build /app/packages/environment-auth ./packages/environment-auth
COPY --from=build /app/packages/mcp-security ./packages/mcp-security
COPY --from=build /app/packages/protocol ./packages/protocol
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "apps/environment-router/dist/server.js"]
