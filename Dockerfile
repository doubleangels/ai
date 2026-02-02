# Dockerfile for AI Bot
# Multi-stage build for optimized image size and security

# Use specific Node.js Alpine version for smaller image size
FROM node:24.13.0-alpine3.23 AS base

ENV NODE_ENV=production

WORKDIR /app

# Install runtime dependencies and create user in a single layer with BuildKit cache
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --no-cache dumb-init gosu procps && \
    addgroup -g 1001 nodejs && \
    adduser -u 1001 -G nodejs -s /bin/sh -D discordbot

# Copy package files for dependency installation (better caching)
COPY package*.json ./

# Build stage for native modules
FROM base AS builder

# Install build dependencies for native modules with BuildKit cache
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --no-cache python3 build-base

# Install dependencies with BuildKit cache mount for faster rebuilds
# Using --omit=dev to exclude dev dependencies in production build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && \
    npm cache clean --force

# Remove build dependencies to reduce image size
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk del python3 build-base

# Final runtime stage
FROM base AS runtime

# Install runtime dependencies and bws in a single layer with BuildKit cache
# jq is kept as it's needed by the entrypoint script
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --no-cache ca-certificates curl jq unzip && \
    curl -fL -o /tmp/bws.zip https://github.com/bitwarden/sdk/releases/download/bws-v1.0.0/bws-x86_64-unknown-linux-gnu-1.0.0.zip && \
    unzip -q /tmp/bws.zip -d /usr/local/bin/ && \
    rm -f /tmp/bws.zip && \
    chmod +x /usr/local/bin/bws && \
    apk del curl unzip

# Copy node_modules from builder stage (before app files for better caching)
COPY --from=builder --chown=discordbot:nodejs /app/node_modules ./node_modules

# Copy entrypoint script first (changes less frequently than app code)
COPY --chown=discordbot:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh

# Copy application files (this layer changes most frequently)
# Use .dockerignore to exclude unnecessary files from build context
COPY --chown=discordbot:nodejs . .

# Set permissions and create data directory
RUN chmod +x /app/docker-entrypoint.sh && \
    mkdir -p /app/data && \
    chown -R discordbot:nodejs /app && \
    chmod 750 /app/data && \
    chmod +x /app/scripts/*.sh 2>/dev/null || true

# Create volume mount point for database persistence
VOLUME ["/app/data"]

# Add health check - verify the bot process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD pgrep -f "node.*index.js" > /dev/null || exit 1

# Entrypoint runs as root to fix permissions, then switches to discordbot user
ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]

CMD ["gosu", "discordbot", "node", "index.js"]
