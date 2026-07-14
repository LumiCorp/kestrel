FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production

RUN corepack enable

WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile

CMD ["pnpm", "--filter", "@kestrel/kestrel-one", "worker:runpod"]
