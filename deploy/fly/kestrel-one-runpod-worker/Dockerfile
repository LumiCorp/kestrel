FROM node:22-bookworm-slim

ARG KESTREL_GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.revision=$KESTREL_GIT_SHA

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production

RUN corepack enable

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile

WORKDIR /workspace/apps/web

CMD ["node", "--conditions=react-server", "--import", "tsx", "scripts/managed-runpod-worker.ts"]
