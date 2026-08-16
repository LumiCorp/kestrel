FROM node:22-bookworm-slim

ARG KESTREL_BUILD_ID=unknown
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.version=$KESTREL_BUILD_ID

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
ENV KESTREL_BUILD_ID=$KESTREL_BUILD_ID

RUN corepack enable

WORKDIR /workspace
COPY . .
RUN printf '%s\n' "$KESTREL_BUILD_ID" > /workspace/.kestrel-build-id
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm run web:prepare

CMD ["pnpm", "--filter", "@kestrel/kestrel-one", "worker:control"]
