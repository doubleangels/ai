# syntax=docker/dockerfile:1.4
# Dockerfile for AI Bot
# Multi-stage build. Use node:24-alpine (no digest) so CI can pull latest Node + Alpine each build.

FROM node:24-alpine AS base

ENV NODE_ENV=production

WORKDIR /app

# Update Alpine package index and upgrade all packages, then add runtime deps
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache dumb-init su-exec procps && \
    addgroup -g 1001 nodejs && \
    adduser -u 1001 -G nodejs -s /bin/sh -D discordbot

# Use latest npm
RUN npm install -g npm@latest && npm cache clean --force

# Copy package files for dependency installation (better caching)
COPY package*.json ./

# Build stage for native modules
FROM base AS builder

RUN --mount=type=cache,target=/root/.npm \
    apk update && apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    apk del python3 make g++

# Final runtime stage
FROM base AS runtime

# Install Doppler CLI for runtime secrets (apk repo)
RUN apk update && apk add --no-cache ca-certificates wget && \
    wget -q -t3 'https://packages.doppler.com/public/cli/rsa.8004D9FF50437357.key' -O /etc/apk/keys/cli@doppler-8004D9FF50437357.rsa.pub && \
    echo 'https://packages.doppler.com/public/cli/alpine/any-version/main' >> /etc/apk/repositories && \
    apk update && apk add --no-cache doppler && \
    apk del wget

# Copy node_modules from builder stage (before app files for better caching)
COPY --from=builder --chown=discordbot:nodejs /app/node_modules ./node_modules

# Copy application files (this layer changes most frequently).
# Use a .dockerignore to exclude node_modules, .git, and other unneeded files from the build context.
COPY --chown=discordbot:nodejs . .

# Set permissions and create data directory in a single layer
RUN mkdir -p /app/data && \
    chown -R discordbot:nodejs /app && \
    chmod 750 /app/data

# Create volume mount point for database persistence
VOLUME ["/app/data"]

# Doppler config/cache dir; use /tmp so it works when root FS is read-only (compose tmpfs: /tmp)
ENV DOPPLER_CONFIG_DIR=/tmp

# Add health check - verify the bot process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD pgrep -f "node.*index.js" > /dev/null || exit 1

# Doppler injects secrets as env vars at runtime. Pass DOPPLER_TOKEN when running the container.
ENTRYPOINT ["dumb-init", "--", "doppler", "run", "--"]

CMD ["su-exec", "discordbot", "node", "index.js"]
