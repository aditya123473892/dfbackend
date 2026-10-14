FROM node:18-slim

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

# Copy the rest of the source (scripts/ + mongo_DF/ needed for the seed service)
COPY . .

# Default DB points at the compose `mongo` service; compose overrides via environment.
ARG DATABASE_URL=mongodb://root:password@mongo:27017/?authSource=admin
ENV NODE_ENV=production \
  PORT=9000 \
  DATABASE_URL=${DATABASE_URL} \
  DATABASE_NAME=darkfantasy \
  JWT_SECRET=development-jwt-secret-change-me \
  EXPIRES_IN=7d \
  PASSWORD_ENCRYPTION_PRIVATE_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  PUBLIC_SITE_DOMAIN=http://localhost:3000 \
  ADMIN_SITE_DOMAIN=http://localhost:3000 \
  AWS_DEFAULT_S3_BUCKET=dark-fantacy-dev

RUN npm run build

EXPOSE 9000

CMD ["npm", "run", "start:prod"]

