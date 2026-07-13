FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/workspace-runtime/package.json apps/workspace-runtime/package.json
COPY packages/environment-auth/package.json packages/environment-auth/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile
COPY apps/workspace-runtime apps/workspace-runtime
COPY packages/environment-auth packages/environment-auth
COPY packages/sdk packages/sdk
COPY packages/protocol packages/protocol
COPY agents agents
COPY cli cli
COPY models models
COPY src src
COPY tools tools
COPY db db
RUN pnpm run build && pnpm --filter @kestrel/workspace-runtime build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./dist/db
COPY --from=build /app/apps/workspace-runtime ./apps/workspace-runtime
COPY --from=build /app/packages/environment-auth ./packages/environment-auth
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/packages/sdk ./packages/sdk
RUN test -f /app/dist/db/migrations/001_sessions_runs.sql && mkdir -p /workspace
ENV NODE_ENV=production KESTREL_WORKSPACE_ROOT=/workspace KESTREL_WORKSPACE_PORT=43104
EXPOSE 43104
CMD ["node", "apps/workspace-runtime/dist/server.js"]
