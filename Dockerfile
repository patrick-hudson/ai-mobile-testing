# syntax=docker/dockerfile:1.7
ARG PLAYWRIGHT_VERSION=1.62.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

WORKDIR /work

ENV CI=1 \
    HOST=0.0.0.0 \
    PORT=4173 \
    PORTAL_ARTIFACT_ROOT=/work/artifacts/runs \
    PORTAL_SECRET_ROOT=/work/secrets \
    NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt \
    PLAYWRIGHT_FIREFOX_CA_CERT=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt \
    PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH=/work/docker/firefox-with-ca.sh \
    FFMPEG_PATH=/usr/bin/ffmpeg

COPY certs/development-ca.crt /usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt
RUN mkdir -p /usr/lib/mozilla/certificates \
    && cp /usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt /usr/lib/mozilla/certificates/ai-mobile-testing-netskope-ca.crt \
    && chmod 0644 /usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt /usr/lib/mozilla/certificates/ai-mobile-testing-netskope-ca.crt \
    && update-ca-certificates \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libnss3-tools util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY docker/firefox-policies.json /tmp/ai-mobile-testing-firefox-policies.json
RUN for firefox_directory in /ms-playwright/firefox-*/firefox; do mkdir -p "$firefox_directory/distribution"; cp /tmp/ai-mobile-testing-firefox-policies.json "$firefox_directory/distribution/policies.json"; done && rm /tmp/ai-mobile-testing-firefox-policies.json

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run validate
RUN mkdir -p /work/artifacts/runs /work/secrets \
    && chmod 700 /work/secrets \
    && chmod 755 /work/docker/entrypoint.sh /work/docker/firefox-with-ca.sh

EXPOSE 4173
VOLUME ["/work/artifacts", "/work/secrets"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/healthz').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["/work/docker/entrypoint.sh"]
CMD ["npm", "run", "portal:container"]
