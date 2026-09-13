# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native build toolchain for better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

# Reinstall production dependencies only. `npm prune` leaves workspace
# devDependencies behind, and the native module is rebuilt here while the
# toolchain is still present.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV FAUXR_DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data

# npm workspaces hoist every dependency to the root, so there is no
# server/node_modules to copy - the root tree is the whole runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
