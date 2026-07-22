FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/environment-router/package.json apps/environment-router/package.json
COPY packages/environment-auth/package.json packages/environment-auth/package.json
RUN pnpm install --frozen-lockfile --filter @kestrel/environment-router...
COPY apps/environment-router apps/environment-router
COPY packages/environment-auth packages/environment-auth
RUN pnpm --filter @kestrel/environment-router build

FROM node:22-bookworm-slim
ARG KESTREL_GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.revision=$KESTREL_GIT_SHA
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/environment-router ./apps/environment-router
COPY --from=build /app/packages/environment-auth ./packages/environment-auth
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "apps/environment-router/dist/server.js"]
