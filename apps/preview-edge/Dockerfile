FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/preview-edge/package.json apps/preview-edge/package.json
COPY packages/environment-auth/package.json packages/environment-auth/package.json
RUN pnpm install --frozen-lockfile --filter @kestrel/preview-edge...
COPY apps/preview-edge apps/preview-edge
COPY packages/environment-auth packages/environment-auth
RUN pnpm --filter @kestrel/preview-edge build

FROM node:22-bookworm-slim
ARG KESTREL_GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.revision=$KESTREL_GIT_SHA
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/preview-edge ./apps/preview-edge
COPY --from=build /app/packages/environment-auth ./packages/environment-auth
ENV NODE_ENV=production PORT=8080 HEALTH_PORT=8081
EXPOSE 8080 8081
CMD ["node", "apps/preview-edge/dist/server.js"]
