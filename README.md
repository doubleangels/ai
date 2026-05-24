<div align="center">
  <img src="https://raw.githubusercontent.com/doubleangels/ai/main/logo.png" alt="Logo" width="200" style="border-radius: 20px; margin-bottom: 20px;">

  <h1>AI Discord Bot</h1>
  <p><b>A multi-provider AI Discord assistant powered by OpenAI, Google Gemini, and Anthropic Claude.</b></p>

  [![Node.js](https://img.shields.io/badge/node.js-24.x-brightgreen.svg?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
  [![Discord.js](https://img.shields.io/badge/discord.js-14.x-blue.svg?style=flat-square&logo=discord)](https://discord.js.org/)
  [![Docker](https://img.shields.io/badge/docker-ready-2496ED.svg?style=flat-square&logo=docker)](https://www.docker.com/)
  [![Doppler](https://img.shields.io/badge/doppler-secrets-000000.svg?style=flat-square&logo=doppler)](https://www.doppler.com/)
  [![Sentry](https://img.shields.io/badge/sentry-observability-362D59.svg?style=flat-square&logo=sentry)](https://sentry.io/)
</div>

<hr>

## Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Observability](#observability)
- [Usage](#usage)
- [Development](#development)
- [Documentation](#documentation)

---

## Features

- **Multi-model AI** — Switch between OpenAI, Gemini, and Claude via configuration.
- **Vision** — Attach images; the bot analyzes charts, photos, and screenshots.
- **Shared channel memory** — Per-channel conversation history for collaborative threads.
- **Reply-chain context** — Traces Discord reply chains for context on new threads; reuses channel history when a conversation already exists.
- **Web search & maps** — Optional live search (OpenAI/Gemini) and Google Maps grounding (Gemini).
- **Prompt caching** — Reduces cost and latency for long conversations.
- **Anti-spam** — Per-user and per-channel cooldowns, queue backpressure, safe mention defaults.
- **Memory optimized** — Bounded reply-chain cache, current-message vision only, cooldown pruning, and aggressive Discord.js cache limits for container deployments.
- **Production observability** — Sentry errors, traces, profiling, logs, and custom metrics via Pino.
- **Secure secrets** — Doppler injects environment variables at runtime.

---

## Quick Start

### Prerequisites

- [Discord Developer Portal](https://discord.com/developers/applications) — bot token and client ID
- API key from [OpenAI](https://platform.openai.com/), [Gemini](https://aistudio.google.com/apikey), or [Anthropic](https://console.anthropic.com/)
- [Doppler](https://www.doppler.com/) for secrets
- Docker and Docker Compose

### Configure Doppler

Add these secrets to your Doppler config (e.g. `prd` or `dev`):

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY` (matching your provider)

Generate a service token for the config you deploy.

### Deploy with Docker Compose

```yaml
services:
  ai:
    image: ghcr.io/doubleangels/ai:latest
    container_name: ai-discord-bot
    restart: unless-stopped
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID
    security_opt:
      - no-new-privileges:true
    read_only: true
    environment:
      - DOPPLER_TOKEN=${DOPPLER_TOKEN}
      - NODE_OPTIONS=--max-old-space-size=256
    tmpfs:
      - /tmp
```

```bash
export DOPPLER_TOKEN="dp.st.config.your_token_here"
docker compose up -d
```

Production images exclude tests, coverage config, and dev dependencies. See [Development](./docs/development.md#docker).

---

## Configuration

Add optional keys to Doppler to customize behavior.

### AI provider and models

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AI_PROVIDER` | `openai`, `gemini`, or `claude` | `openai` |
| `OPENAI_MODEL_NAME` | OpenAI model | `gpt-5.4-nano` |
| `GEMINI_MODEL_NAME` | Gemini model | `gemini-3-flash-preview` |
| `CLAUDE_MODEL_NAME` | Claude model | `claude-sonnet-4-6` |
| `ALLOWED_GUILD_IDS` | Comma-separated guild IDs (empty = all) | *All servers* |

### Advanced AI settings

| Variable | Description | Default |
| :--- | :--- | :--- |
| `ENABLE_WEB_SEARCH` | Live internet search (OpenAI/Gemini) | `false` |
| `ENABLE_GOOGLE_MAPS` | Google Maps grounding (Gemini) | `false` |
| `ENABLE_CONTEXT_CACHE` | Long-context caching | `false` |
| `REASONING_EFFORT` | OpenAI reasoning: `low`, `medium`, `high` | `none` |
| `RESPONSES_VERBOSITY` | Response verbosity | `low` |
| `CLAUDE_THINKING_BUDGET_TOKENS` | Claude extended thinking (0 = off) | `0` |

### Conversation and cost limits

| Variable | Description | Default |
| :--- | :--- | :--- |
| `MAX_OUTPUT_TOKENS` | Response token cap (256–65536) | `1024` |
| `MAX_HISTORY_TOKENS` | Channel history cap (0 = off) | `0` |
| `USER_COOLDOWN_MS` | Per-user cooldown | `4000` |
| `CHANNEL_COOLDOWN_MS` | Per-channel cooldown | `1500` |
| `MAX_PENDING_PER_CHANNEL` | Queue depth before "busy" reply | `3` |
| `MAX_HISTORY_LENGTH` | Max messages kept per channel (plus system); minimum `1` | `20` |
| `CONVERSATION_HISTORY_MAX_CHANNELS` | Max in-memory channel histories (LRU by last activity; `0` = no cap) | `500` |
| `CONVERSATION_HISTORY_IDLE_MS` | Drop channel history after this idle period (`0` = disabled) | `86400000` (24h) |

### Performance and memory

These settings control reply-chain traversal and in-process caching before each AI call. Lower values reduce memory use and pre-API latency; higher values preserve more Discord thread context on brand-new conversations.

| Variable | Description | Default | Valid range |
| :--- | :--- | :--- | :--- |
| `MAX_REPLY_CHAIN_DEPTH` | How many parent messages to fetch when tracing a reply chain | `15` | 1–50 |
| `MESSAGE_CACHE_MAX_SIZE` | Max Discord messages cached for reply-chain fetches (LRU eviction) | `500` | 10–10000 |
| `MESSAGE_CACHE_TTL_MS` | How long cached Discord messages stay valid (milliseconds) | `1800000` (30 min) | 60000–86400000 |

**Behavior notes:**

- Reply-chain **text** is injected only when the channel has no prior turns beyond the system message. Ongoing threads rely on `conversationHistory` instead.
- **Images** are downloaded and sent to the model only for the current message, not for every message in the reply chain.
- Setting `MAX_HISTORY_TOKENS` (see table above) is recommended for long threads to cap API payload size.

---

## Observability

Set `SENTRY_DSN` in Doppler to enable Sentry. The bot reports errors, performance traces, structured logs, custom metrics, and optional profiling.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SENTRY_DSN` | *unset* | Enable reporting |
| `SENTRY_TRACES_SAMPLE_RATE` | `1.0` | Performance traces |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | `1.0` | Code profiling |
| `SENTRY_PROFILE_LIFECYCLE` | `trace` | Profile lifecycle |
| `SENTRY_ENABLE_LOGS` | `true` | Pino → Sentry logs |
| `SENTRY_ENABLE_METRICS` | `true` | Custom metrics |
| `SENTRY_SEND_DEFAULT_PII` | `false` | Send default PII to Sentry (user IDs, etc.) |

Full metric and span reference: [docs/observability.md](./docs/observability.md).

---

## Usage

### Interacting with the bot

- **Mention:** `@AI What is the capital of France?`
- **Reply:** Use Discord's reply feature on a bot message to continue a thread.
- The bot ignores `@here` and `@everyone`.

### Images

Attach an image with a caption like `@AI describe this chart` for multi-modal analysis.

### Admin commands

- `/reset` — Clear conversation history (channel or server scope). Requires **Administrator**.

---

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test                      # CI runs this
pnpm test:coverage:check   # local 100% coverage gate
```

See [docs/development.md](./docs/development.md) for local setup, Docker build notes, and project layout.

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Development](./docs/development.md) | Testing, coverage, Docker exclusions |
| [Observability](./docs/observability.md) | Sentry errors, traces, logs, metrics |

<br>
<div align="center">
  <sub>Built with Node.js and Discord.js</sub>
</div>
