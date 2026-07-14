FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace
COPY . .

# The worker runs TypeScript directly so the image intentionally includes the
# web package development toolchain. It contains no public HTTP service.
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm run web:prepare

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@kestrel/kestrel-one", "worker:turns"]
