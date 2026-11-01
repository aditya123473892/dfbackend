FROM node:22-bookworm-slim AS build

WORKDIR /app

# bcrypt 5.x needs build tools to compile from source on Linux.
# Debian-slim binaries are used instead of Alpine: the Alpine CDN stalled
# repeatedly on gcc (~100s, DNS/IO errors), while Debian apt is reliable here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching, reproducible via lockfile)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source; credentials, local uploads and database dumps stay outside images.
COPY . .

# Supply database credentials and signing/encryption secrets at deployment.
# No production credential defaults are baked into the image.
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=9000 HOST=0.0.0.0
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./package.json
USER node

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "-r", "./dist/src/register-paths.js", "dist/src/main.js"]

