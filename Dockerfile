# ---- build: compile native deps, bundle the web app, compile the server ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --include=dev: the build needs TypeScript/Vite/Vitest even if NODE_ENV=production is injected
RUN npm ci --include=dev
COPY . .
# A commit that fails type checking or any test never produces an image, so the running
# version stays up (Coolify only swaps containers after a successful build).
RUN npm run typecheck && npm test && npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
# Coolify replaces HEALTHCHECK with its own curl/wget probe, so the image must ship curl.
# munsif.im: libreoffice-impress converts uploaded PPTX presentations to PDF (headless `soffice`, found on PATH;
# one conversion at a time, 90 s limit). It adds ~400 MB to the image; without it teams are asked for a PDF.
# fonts-dejavu (+ Carlito/Liberation, metric-compatible with Calibri/Arial) keep the converted slides' layout.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
      libreoffice-impress fonts-dejavu fonts-crosextra-carlito fonts-liberation2 \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data ASSETS_DIR=/app/assets WEB_DIR=/app/dist/web
# Shown in /api/health and the platform panel (Coolify passes SOURCE_COMMIT when "include source commit" is on).
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package.json ./
COPY assets ./assets
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" > /dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/index.js"]
