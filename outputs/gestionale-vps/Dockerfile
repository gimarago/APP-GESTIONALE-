FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
WORKDIR /app

# Required by the optional PEC collector and direct SdI XML validator. Bundled XSD/WSDL files
# are validated locally; no XML schema is downloaded at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-lxml ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=root:root package.json package-lock.json /app/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# New named volumes inherit these permissions. The application never runs as root.
RUN mkdir -p /data /backups /app/deploy \
    && chown node:node /data /backups \
    && chmod 700 /data /backups

# .dockerignore is an allowlist: local launchers, backups and secrets
# are deliberately absent from the runtime image.
COPY --chown=root:root . /app/
USER node:node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "server/server.mjs"]
