# syntax=docker/dockerfile:1.7
ARG PLAYWRIGHT_VERSION=1.62.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG INSTALL_MSEDGE=0

WORKDIR /work

ENV CI=1 \
    HOST=0.0.0.0 \
    PORT=4173 \
    PORTAL_ARTIFACT_ROOT=/work/artifacts/runs \
    PORTAL_SECRET_ROOT=/var/lib/ai-mobile-testing/secrets \
    PORTAL_RUNNER_HOME=/home/pwuser \
    PORTAL_AI_WORKER_HOME=/home/aiworker \
    PORTAL_REPORT_WORKER_HOME=/home/reportworker \
    NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt \
    PLAYWRIGHT_FIREFOX_CA_CERT=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt \
    PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH=/work/docker/firefox-with-ca.sh \
    AUDIT_MSEDGE_AVAILABLE=${INSTALL_MSEDGE} \
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
RUN test "$(id -u pwuser)" != "0" \
    && test "$(id -g pwuser)" != "0" \
    && test "$(getent passwd pwuser | cut -d: -f6)" = "$PORTAL_RUNNER_HOME" \
    && test -d "$PORTAL_RUNNER_HOME"
RUN useradd --create-home --home-dir "$PORTAL_AI_WORKER_HOME" --gid "$(id -g pwuser)" --shell /usr/sbin/nologin aiworker \
    && test "$(id -u aiworker)" != "0" \
    && test "$(id -u aiworker)" != "$(id -u pwuser)" \
    && test "$(id -g aiworker)" = "$(id -g pwuser)" \
    && test "$(getent passwd aiworker | cut -d: -f6)" = "$PORTAL_AI_WORKER_HOME" \
    && test -d "$PORTAL_AI_WORKER_HOME"
RUN useradd --create-home --home-dir "$PORTAL_REPORT_WORKER_HOME" --gid "$(id -g pwuser)" --shell /usr/sbin/nologin reportworker \
    && test "$(id -u reportworker)" != "0" \
    && test "$(id -u reportworker)" != "$(id -u pwuser)" \
    && test "$(id -u reportworker)" != "$(id -u aiworker)" \
    && test "$(id -g reportworker)" = "$(id -g pwuser)" \
    && test "$(getent passwd reportworker | cut -d: -f6)" = "$PORTAL_REPORT_WORKER_HOME" \
    && test -d "$PORTAL_REPORT_WORKER_HOME"
RUN case "$INSTALL_MSEDGE" in \
      0) echo "Optional branded Microsoft Edge capability disabled" ;; \
      1) npx playwright install msedge ;; \
      *) echo "INSTALL_MSEDGE must be exactly 0 or 1" >&2; exit 2 ;; \
    esac

COPY . .
RUN npm run validate
RUN mkdir -p /work/artifacts/runs /var/lib/ai-mobile-testing/secrets \
    && chmod 700 /var/lib/ai-mobile-testing/secrets \
    && chmod 755 /work/docker/entrypoint.sh /work/docker/firefox-with-ca.sh

EXPOSE 4173
VOLUME ["/work/artifacts", "/var/lib/ai-mobile-testing/secrets"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/healthz').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["/work/docker/entrypoint.sh"]
CMD ["npm", "run", "portal:container"]
