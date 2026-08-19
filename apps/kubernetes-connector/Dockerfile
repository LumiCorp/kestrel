FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/kubernetes-connector/package.json apps/kubernetes-connector/package.json
COPY packages/environment-auth/package.json packages/environment-auth/package.json
RUN pnpm install --frozen-lockfile --filter @kestrel/kubernetes-connector...
COPY apps/kubernetes-connector apps/kubernetes-connector
COPY packages/environment-auth packages/environment-auth
RUN pnpm --filter @kestrel/kubernetes-connector build
COPY apps/kubernetes-connector/docker-root-package.json package.json
RUN pnpm --filter @kestrel/kubernetes-connector deploy --prod /prod/connector

FROM node:22-bookworm-slim
WORKDIR /app
RUN groupadd --system --gid 10001 kestrel \
  && useradd --system --uid 10001 --gid kestrel --home-dir /nonexistent kestrel
COPY --from=build /prod/connector /app
ENV NODE_ENV=production PORT=8080
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
