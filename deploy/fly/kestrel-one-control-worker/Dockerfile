FROM node:22-bookworm-slim

ARG KESTREL_GIT_SHA=unknown
ARG KESTREL_CONTROL_WORKER_FINGERPRINT=unknown

LABEL org.opencontainers.image.source="https://github.com/LumiCorp/kestrel"
LABEL org.opencontainers.image.revision=$KESTREL_GIT_SHA
LABEL org.kestrel.control-worker.fingerprint=$KESTREL_CONTROL_WORKER_FINGERPRINT

ENV NODE_ENV=production
ENV KESTREL_BUILD_REVISION=$KESTREL_GIT_SHA

WORKDIR /app

COPY control-worker.cjs verify-control-worker-readiness.cjs ./

CMD ["node", "/app/control-worker.cjs"]
