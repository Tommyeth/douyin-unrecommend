FROM node:24-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc openbox supervisor fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci && npx playwright-core install --with-deps chromium \
    && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY migrations ./migrations
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
RUN npm run build:desktop && mkdir -p /app/data /tmp/runtime-node /tmp/.X11-unix \
    && chown -R node:node /app/data /tmp/runtime-node && chmod 700 /tmp/runtime-node && chmod 1777 /tmp/.X11-unix
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/browser.sqlite \
    DISPLAY=:99 DESKTOP_ENABLED=1 XDG_RUNTIME_DIR=/tmp/runtime-node
USER node
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]
