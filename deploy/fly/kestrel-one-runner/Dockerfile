FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm --config.link-workspace-packages=false \
  --filter @kestrel-agents/kestrel \
  deploy /opt/kestrel --prod
RUN chmod -R a+rX /opt/kestrel

FROM node:22-bookworm-slim AS runtime

ARG KESTREL_GIT_SHA=unknown

LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.revision=$KESTREL_GIT_SHA

ENV HOME=/home/kestrel
ENV KESTREL_BUILD_REVISION=$KESTREL_GIT_SHA
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install --yes --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system kestrel \
  && useradd --system --gid kestrel --home-dir /home/kestrel --create-home kestrel

WORKDIR /app
COPY --from=builder /opt/kestrel /app
COPY --from=builder /workspace/package.json /app/dist/package.json
COPY --from=builder /opt/kestrel/db/migrations /app/dist/db/migrations
COPY --chmod=0755 deploy/fly/kestrel-one-runner/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deploy/fly/kestrel-one-runner/runner-entrypoint.mjs /app/runner-entrypoint.mjs

EXPOSE 8080

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "runner-entrypoint.mjs", "--host", "0.0.0.0", "--port", "8080"]
