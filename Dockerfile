FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY migrations ./migrations
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/state.sqlite
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
