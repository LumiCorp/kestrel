FROM node:22-bookworm-slim

ARG KESTREL_BUILD_ID=unknown
ARG KESTREL_HOSTED_APPROVAL_PROTOCOL=v2
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.version=$KESTREL_BUILD_ID
LABEL com.lumicorp.kestrel.hosted-approval-producer=$KESTREL_HOSTED_APPROVAL_PROTOCOL

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace
COPY . .
RUN printf '%s\n' "$KESTREL_BUILD_ID" > /workspace/.kestrel-build-id

# The worker runs TypeScript directly so the image intentionally includes the
# web package development toolchain. It contains no public HTTP service.
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm run web:prepare

ENV NODE_ENV=production
ENV KESTREL_BUILD_ID=$KESTREL_BUILD_ID
ENV KESTREL_HOSTED_APPROVAL_PROTOCOL=$KESTREL_HOSTED_APPROVAL_PROTOCOL

CMD ["pnpm", "--filter", "@kestrel/kestrel-one", "worker:turns"]
