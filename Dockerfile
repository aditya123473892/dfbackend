FROM node:22-slim

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
ENV NODE_ENV=production PORT=9000

RUN npm run build

EXPOSE 9000

CMD ["npm", "run", "start:prod"]

