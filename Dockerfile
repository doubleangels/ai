# syntax=docker/dockerfile:1.4
# Dockerfile for AI Bot
# Multi-stage build for optimized image size and security
# Debian-based image for bws (Bitwarden) compatibility

FROM node:24.13.0-trixie-slim AS base

# Set environment variables early for better caching
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

WORKDIR /app

# Install runtime dependencies and create user in a single layer with BuildKit cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    procps && \
    groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/bash -m discordbot && \
    rm -rf /var/lib/apt/lists/*

# Copy package files for dependency installation (better caching)
COPY package*.json ./

# Build stage for native modules
FROM base AS builder

# Install build deps, install dependencies, then purge build deps in a single layer
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/app/.npm \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    build-essential && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    apt-get purge -y --auto-remove \
    python3 \
    make \
    g++ \
    build-essential && \
    rm -rf /var/lib/apt/lists/*

# Final runtime stage
FROM base AS runtime

# Install Doppler CLI for runtime secrets (replaces bws/Bitwarden)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg && \
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" | tee /etc/apt/sources.list.d/doppler-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends doppler && \
    apt-get purge -y --auto-remove curl gnupg && \
    rm -rf /var/lib/apt/lists/*

# Copy node_modules from builder stage (before app files for better caching)
COPY --from=builder --chown=discordbot:nodejs /app/node_modules ./node_modules

# Copy application files (this layer changes most frequently)
# Use .dockerignore to exclude unnecessary files from build context
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

CMD ["gosu", "discordbot", "node", "index.js"]
