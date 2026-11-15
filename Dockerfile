FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/state.sqlite
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
