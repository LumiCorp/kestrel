FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

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

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime-assets

RUN apt-get update \
  && apt-get install --yes --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /staged
COPY deploy/fly/kestrel-one-browser-worker/runtime/linux-x64/agent-browser-linux-x64 ./agent-browser-linux-x64
COPY deploy/fly/kestrel-one-browser-worker/runtime/linux-x64/chrome-linux64.zip ./chrome-linux64.zip
RUN echo "5b2dbebc79f669e06c0eef6749ae3a086c1c8f3421659a90288467d999e2d881  agent-browser-linux-x64" | sha256sum --check --strict - \
  && echo "88af83664e1e5f79dc1c1378d0699b98dddd69690a748addf4ccbe322bfacedf  chrome-linux64.zip" | sha256sum --check --strict - \
  && install -D --mode=0755 agent-browser-linux-x64 /opt/kestrel/browser-runtime/agent-browser \
  && unzip -q chrome-linux64.zip -d /tmp/chrome \
  && mv /tmp/chrome/chrome-linux64 /opt/kestrel/browser-runtime/chrome \
  && chmod -R a+rX /opt/kestrel/browser-runtime

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG KESTREL_BUILD_ID=unknown
ARG KESTREL_GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.version=$KESTREL_BUILD_ID
LABEL org.opencontainers.image.revision=$KESTREL_GIT_SHA
LABEL dev.kestrel.browser.engine="agent-browser:v0.35.0-kestrel.1"
LABEL dev.kestrel.browser.chrome="chrome-for-testing:152.0.7977.54"

ENV HOME=/tmp/kestrel-browser-home
ENV NODE_ENV=production
ENV KESTREL_BUILD_ID=$KESTREL_BUILD_ID
ENV KESTREL_BROWSER_RUNTIME_ROOT=/opt/kestrel/browser-runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    nftables \
    util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 kestrel-browser \
  && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home kestrel-browser

WORKDIR /app
COPY --from=build /opt/kestrel /app
COPY --from=runtime-assets /opt/kestrel/browser-runtime /opt/kestrel/browser-runtime
COPY --chmod=0755 deploy/fly/kestrel-one-browser-worker/entrypoint.sh /usr/local/bin/kestrel-browser-worker-entrypoint

EXPOSE 43105
ENTRYPOINT ["/usr/local/bin/kestrel-browser-worker-entrypoint"]
