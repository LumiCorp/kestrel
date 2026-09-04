FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=true PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install --yes --no-install-recommends \
    curl unzip openssl libnss3-tools ca-certificates fonts-liberation libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
    libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
    libxrandr2 procps && rm -rf /var/lib/apt/lists/*
WORKDIR /suite
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY apps/desktop/.npmrc apps/desktop/
COPY packages/ai-sdk/package.json packages/ai-sdk/
COPY packages/attachments/package.json packages/attachments/
COPY packages/conversation/package.json packages/conversation/
COPY packages/environment-auth/package.json packages/environment-auth/
COPY packages/mcp-security/package.json packages/mcp-security/
COPY packages/memory/package.json packages/memory/
COPY packages/next/package.json packages/next/
COPY packages/observability/package.json packages/observability/
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk/package.json packages/sdk/
COPY packages/workspace-skills/package.json packages/workspace-skills/
COPY apps/desktop/package.json apps/desktop/
COPY apps/desktop-runtime/package.json apps/desktop-runtime/
COPY apps/docs/package.json apps/docs/
COPY apps/environment-router/package.json apps/environment-router/
COPY apps/mcp-service/package.json apps/mcp-service/
COPY apps/preview-edge/package.json apps/preview-edge/
COPY apps/web/package.json apps/web/
COPY apps/workspace-runtime/package.json apps/workspace-runtime/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:shared && pnpm --dir apps/web exec tsc --noEmit -p tests/browser/tsconfig.json
RUN node --import tsx scripts/stage-browser-runtime-sources.ts linux-x64 \
    && mkdir -p /opt/kestrel/browser-runtime \
    && install -m 755 deploy/fly/kestrel-one-browser-worker/runtime/linux-x64/agent-browser-linux-x64 /opt/kestrel/browser-runtime/agent-browser \
    && unzip -q deploy/fly/kestrel-one-browser-worker/runtime/linux-x64/chrome-linux64.zip -d /opt/kestrel/browser-runtime \
    && mv /opt/kestrel/browser-runtime/chrome-linux64 /opt/kestrel/browser-runtime/chrome
WORKDIR /suite/apps/web
ENTRYPOINT ["node", "--import", "./scripts/register-server-only.mjs", "--import", "tsx", "tests/browser/run.ts"]
