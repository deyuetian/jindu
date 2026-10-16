FROM node:22.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY shared ./shared
COPY backend ./backend
COPY server/security.ts ./server/security.ts
COPY public ./public
COPY index.html tsconfig.json vite.config.ts ./
RUN npm run build

FROM node:22.22.2-bookworm-slim AS runtime
LABEL org.opencontainers.image.version="0.15.0" \
      org.opencontainers.image.source="https://github.com/deyuetian/jindu" \
      org.opencontainers.image.licenses="MIT" \
      org.jindu.schema-version="1" \
      org.jindu.upgrade-from-schemas="0,1" \
      org.jindu.rollback-to-schemas="0,1"
ENV NODE_ENV=production PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1 JINDU_CONFIG=/run/jindu/config.json
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates libreoffice-writer-nogui \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/python
COPY backend/requirements.txt ./backend/requirements.txt
RUN /opt/python/bin/python -m pip install --no-cache-dir -r backend/requirements.txt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY backend ./backend
COPY shared ./shared
COPY server/security.ts ./server/security.ts
COPY deploy/portable/*.mjs ./deploy/portable/
COPY deploy/portable/repair-agent-request.ts ./deploy/portable/
COPY --from=build /app/dist ./dist
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 8788
CMD ["node", "--experimental-strip-types", "backend/app.ts"]
