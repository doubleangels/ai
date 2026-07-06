<div align="center">
  <img src="https://raw.githubusercontent.com/doubleangels/ai/main/logo.png" alt="Logo" width="200" style="border-radius: 20px; margin-bottom: 20px;">

  <h1>AI Discord Bot</h1>
  <p><b>A multi-provider AI Discord assistant powered by OpenAI, Google Gemini, and Anthropic Claude.</b></p>

  [![DeepScan grade](https://deepscan.io/api/teams/29402/projects/31349/branches/1015181/badge/grade.svg)](https://deepscan.io/dashboard#view=project&tid=29402&pid=31349&bid=1015181)
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
- [Usage](#usage)
- [Observability](#observability)
- [Development](#development)
- [CI and Docker](#ci-and-docker)
- [Project layout](#project-layout)

---

## Features

- **Multi-model AI** — Switch between OpenAI, Gemini, and Claude via `AI_PROVIDER`.
- **Vision** — Analyze images and GIFs from your message and the reply chain (file attachments and embed previews; capped per request).
- **Image generation** — `/imagine` slash command using [Gemini Image](https://ai.google.dev/gemini-api/docs/image-generation) (`gemini-3.1-flash-image`).
- **Shared channel memory** — Per-channel conversation history for collaborative threads.
- **Reply-chain context** — Traces Discord reply chains and injects quoted parent-message text alongside per-channel history when you reply to the bot.
- **Web search and maps** — Optional live search (OpenAI/Gemini) and Google Maps grounding (Gemini).
- **Prompt caching** — Optional context caching to reduce cost and latency for long conversations.
- **Anti-spam** — Per-user and per-channel cooldowns, per-channel queue backpressure, safe mention defaults.
- **Memory optimized** — Bounded reply-chain cache, capped reply-chain vision downloads, cooldown pruning, and aggressive Discord.js cache limits for container deployments.
- **Production observability** — Sentry errors, traces, profiling, logs, and custom metrics via Pino.
- **Secure secrets** — Doppler injects environment variables at runtime in Docker; local dev uses the Doppler CLI.

---

## Quick Start

### Prerequisites

- [Discord Developer Portal](https://discord.com/developers/applications) — bot token and application (client) ID
- API key for your chosen provider: [OpenAI](https://platform.openai.com/), [Gemini](https://aistudio.google.com/apikey), or [Anthropic](https://console.anthropic.com/)
- [Doppler](https://www.doppler.com/) for secrets (recommended)
- Docker and Docker Compose for production deployment

### Required secrets (Doppler)

| Secret | Purpose |
| :--- | :--- |
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_CLIENT_ID` | Application ID (slash command registration) |
| `OPENAI_API_KEY` | When `AI_PROVIDER=openai` |
| `GEMINI_API_KEY` | When `AI_PROVIDER=gemini` |
| `ANTHROPIC_API_KEY` | When `AI_PROVIDER=claude` |

Generate a Doppler service token for the config you deploy (e.g. `prd`).

### Deploy with Docker Compose

The repository includes [`docker-compose.yml`](docker-compose.yml):

```yaml
services:
  ai:
    image: ghcr.io/doubleangels/ai:latest
    container_name: ai
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

The production image is built from the multi-stage [`Dockerfile`](Dockerfile). The entrypoint runs `doppler run -- node index.js` as an unprivileged user. Set `DOPPLER_TOKEN` at runtime; secrets are not baked into the image.

---

## Configuration

Set variables in Doppler (or `.env` for local experiments). Invalid model names cause the process to exit at startup with a logged error.

### Discord and logging

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DISCORD_BOT_TOKEN` | Bot token | *required* |
| `DISCORD_CLIENT_ID` | Application ID | *required for deploy* |
| `ALLOWED_GUILD_IDS` | Comma-separated guild IDs. Empty = all guilds **and DMs**. Non-empty = listed guilds only (DMs blocked). **Set in production.** | *all servers + DMs* |
| `LOG_LEVEL` | Pino log level | `info` |

### AI provider and models

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AI_PROVIDER` | `openai`, `gemini`, or `claude` | `openai` |
| `OPENAI_MODEL_NAME` | OpenAI model (also fallback for other providers if their model env is unset) | `gpt-5.4-nano` |
| `GEMINI_MODEL_NAME` | Gemini model | `gemini-3-flash-preview` |
| `CLAUDE_MODEL_NAME` | Claude model | `claude-sonnet-4-6` |

Supported model IDs are validated in [`config.js`](config.js). Unsupported values exit the process.

### Advanced AI settings

| Variable | Description | Default |
| :--- | :--- | :--- |
| `ENABLE_WEB_SEARCH` | Live internet search (OpenAI/Gemini) | `false` |
| `ENABLE_GOOGLE_MAPS` | Google Maps grounding (Gemini) | `false` |
| `ENABLE_CONTEXT_CACHE` | Provider context / prompt caching (system + stable turns) | `true` |
| `GEMINI_CACHE_TTL_SECONDS` | Gemini cache TTL (60–86400) | `3600` |
| `GEMINI_SAFETY_SETTINGS` | JSON array of `{ category, threshold }` safety settings | *API defaults* |
| `REASONING_EFFORT` | OpenAI reasoning: `none`, `low`, `medium`, `high`, `xhigh` | `none` |
| `RESPONSES_VERBOSITY` | OpenAI text verbosity: `low`, `medium`, `high` | `low` |
| `CLAUDE_THINKING_BUDGET_TOKENS` | Claude extended thinking budget (`0` = off, max 32000) | `0` |
| `OPENAI_TIMEOUT_MS` | OpenAI client timeout (5000–300000) | `60000` |
| `OPENAI_MAX_RETRIES` | OpenAI client retries (0–5) | `2` |
| `GEMINI_TIMEOUT_MS` | Gemini request timeout (5000–300000) | `60000` |
| `CLAUDE_TIMEOUT_MS` | Claude request timeout (5000–300000) | `60000` |

### Conversation and cost limits

| Variable | Description | Default |
| :--- | :--- | :--- |
| `MAX_OUTPUT_TOKENS` | Response token cap (256–65536) | `1024` |
| `MAX_HISTORY_TOKENS` | Channel history token cap (`0` = disabled) | `0` |
| `MAX_HISTORY_LENGTH` | Max messages per channel (plus system); minimum `1` | `10` |
| `USER_COOLDOWN_MS` | Per-user **per-channel** cooldown (`0` = disabled) | `4000` |
| `SECONDARY_MODEL_NAME` | Secondary model when the primary returns busy/overloaded errors | *unset* |
| `SECONDARY_AI_PROVIDER` | Provider for `SECONDARY_MODEL_NAME`; auto-detected from model ID when unset | *auto* |
| `TERTIARY_MODEL_NAME` | Tertiary model (tried after the secondary model fails) | *unset* |
| `TERTIARY_AI_PROVIDER` | Provider for `TERTIARY_MODEL_NAME`; auto-detected when unset | *auto* |
| `DISCORD_SHARD_COUNT` | Shard count (`auto`, `2`, …); omit or `1` for single process | *single process* |
| `CHANNEL_COOLDOWN_MS` | Per-channel cooldown (`0` = disabled) | `1500` |
| `MAX_PENDING_PER_CHANNEL` | Queue depth before a “busy” reply (`0` = disabled) | `3` |
| `CONVERSATION_HISTORY_MAX_CHANNELS` | Max in-memory channel histories (LRU; `0` = no cap) | `500` |
| `CONVERSATION_HISTORY_IDLE_MS` | Drop idle channel history (`0` = disabled) | `86400000` (24h) |

### Performance and memory

| Variable | Description | Default | Range |
| :--- | :--- | :--- | :--- |
| `MAX_REPLY_CHAIN_DEPTH` | Parent messages to fetch when tracing a reply chain | `15` | 1–50 |
| `MESSAGE_CACHE_MAX_SIZE` | LRU cache size for reply-chain message fetches | `500` | 10–10000 |
| `MESSAGE_CACHE_TTL_MS` | Message cache TTL (ms) | `1800000` (30 min) | 60000–86400000 |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | Vision image download timeout | `8000` | — |
| `MAX_IMAGE_BYTES` | Max bytes per downloaded image | `6000000` | — |
| `MAX_REPLY_CHAIN_IMAGES` | Max images/GIFs collected from a reply chain per request | `4` | 1–10 |

### Image generation (`/imagine`)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | API key from [Google AI Studio](https://aistudio.google.com/apikey) (also used when `AI_PROVIDER=gemini`) | *unset* |
| `GEMINI_IMAGE_MODEL_NAME` | Gemini Image model for `/imagine` | `gemini-3.1-flash-image` |
| `IMAGE_GENERATION_TIMEOUT_MS` | Image request timeout (10000–300000) | `120000` |
| `IMAGE_USER_COOLDOWN_MS` | Per-user per-channel cooldown for `/imagine` (`0` = disabled) | `30000` |

The bot starts without `GEMINI_API_KEY`; `/imagine` is disabled until the key is set (same key as Gemini chat when using `AI_PROVIDER=gemini`).

**Behavior notes:**

- When you **reply** to the bot, quoted text from the reply chain is prepended to your message **in addition to** stored `conversationHistory` (useful for translation and thread grounding).
- **Images and GIFs** (attachments and embed previews) are collected from non-bot messages in the reply chain, oldest first, up to `MAX_REPLY_CHAIN_IMAGES`. Video attachments are not analyzed.
- Set `MAX_HISTORY_TOKENS` in production for long threads to cap API payload size.
- With `ENABLE_CONTEXT_CACHE=true` (default), the system prompt and prior turns are marked for provider prompt caching (~90% off cached input tokens). Each bot **process** creates its own Gemini cache entry; multiple replicas each pay a one-time cache-creation cost on cold start. Set `ENABLE_CONTEXT_CACHE=false` to disable.
- **History staleness:** `conversationHistory` does not track Discord message IDs. Edited or deleted user messages may remain in memory until `/reset`, idle eviction, or token/length trimming. Deleting a **bot** reply removes the matching last assistant turn when content still matches.
- **SVG images** are excluded from vision (raster formats only).
- Set `SECONDARY_MODEL_NAME` (and optionally `TERTIARY_MODEL_NAME`) to lighter models if your primary often returns rate-limit or overload errors. Provider is inferred from the model ID; override with `SECONDARY_AI_PROVIDER` / `TERTIARY_AI_PROVIDER`. Each backup can use a different provider; its API key must be configured.

---

## Usage

### Interacting with the bot

- **Mention:** `@AI What is the capital of France?` (direct user mention or a **role** that includes the bot)
- **Reply:** Use Discord’s reply feature on a bot message to continue a thread.
- The bot ignores `@here` and `@everyone` unless it is also mentioned.
- **Reply style:** Answers default to short TLDR form (direct answer first). Ask for more detail, steps, or code if you need a longer reply.

### Images

Attach an image with a caption such as `@AI describe this chart` for multimodal analysis.

Generate an image with `/imagine prompt:a sunset over mountains` (requires `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey)). Optional `size` (aspect ratio) is available.

### Slash commands

| Command | Description | Permission |
| :--- | :--- | :--- |
| `/imagine` | Generate an image from a text prompt (Gemini Image) | Everyone |
| `/reset` | Clear history for a channel (including threads) or **this server only** | Administrator |

Slash commands are registered automatically when the bot starts (`index.js` calls `deploy-commands.js` before connecting). To deploy without starting the bot:

```bash
pnpm commands:deploy
```

---

## Observability

Set `SENTRY_DSN` in Doppler to enable Sentry. [`instrument.js`](instrument.js) loads **before** other application modules.

### Sentry environment variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SENTRY_DSN` | *unset* | Enable reporting |
| `SENTRY_TRACES_SAMPLE_RATE` | `1.0` | Performance traces (`0.0`–`1.0`) |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | `1.0` | Code profiling sample rate |
| `SENTRY_PROFILE_LIFECYCLE` | `trace` | Profile lifecycle (e.g. `trace`, `manual`) |
| `SENTRY_ENABLE_LOGS` | `true` | Forward Pino logs to Sentry |
| `SENTRY_ENABLE_METRICS` | `true` | Emit custom metrics |
| `SENTRY_SEND_DEFAULT_PII` | `false` | Send default PII (user IDs, etc.) |
| `NODE_ENV` | `production` | Sentry environment tag; local variable capture is enabled only when not `production` |

Sample rates are clamped to `[0, 1]`. Invalid values fall back to `1.0`.

Local variables on errors (`includeLocalVariables`) follow nova: enabled in non-production environments only. In Docker with `NODE_ENV=production` (the default), Sentry does not open the Node inspector, so container logs stay free of “Debugger listening on ws://…”.

### Errors

`captureError(error, tags)` from `instrument.js` attaches stringified tags and calls `captureException`. Used in `index.js`, `config.js`, `deploy-commands.js`, `aiService.js`, `messageCreate.js`, `ready.js`, and `reset.js`.

### Performance spans

`startSpan(options, callback)` wraps async work. If `Sentry.startSpan` is unavailable, the callback runs directly.

| Span | Module | Purpose |
| :--- | :--- | :--- |
| Client ready / login | `index.js` | Bot lifecycle |
| Slash and context menu handlers | `index.js` | Command execution |
| Message AI response | `messageCreate.js` | End-to-end message handling |
| AI provider call | `aiService.js` | OpenAI / Gemini / Claude request |
| Command deploy | `deploy-commands.js` | Slash command registration |
| Client ready setup | `ready.js` | Post-login setup |

Profiling uses `@sentry/profiling-node` when available; if the integration fails to load, the bot continues without profiling.

### Logs

[`logger.js`](logger.js) wraps Pino and forwards `info`, `warn`, `error`, `debug`, `trace`, and `fatal` to `Sentry.logger` when logs are enabled. Forwarding failures are swallowed and logged locally at debug level.

### Custom metrics

Metrics are no-ops when Sentry is disabled or metrics are turned off. Attributes are normalized (objects JSON-stringified; `null`/`undefined` dropped).

**Counters (`recordCount`)**

| Metric | Attributes | Source |
| :--- | :--- | :--- |
| `ai.generate.requests` | `provider`, `outcome` | `aiService.js` |
| `discord.message.received` | `provider`, `trigger` | `messageCreate.js` |
| `discord.message.responded` | `provider`, `outcome` | `messageCreate.js` |
| `discord.message.rejected` | `reason` | `messageCreate.js` |
| `discord.command.executed` | `command`, `outcome` | `index.js` |
| `discord.context_menu.executed` | `command`, `outcome` | `index.js` |
| `discord.api.failure` | `location`, `httpStatus`, … | multiple |
| `discord.api.rate_limit` | `location`, … | multiple |
| `discord.login` | — | `index.js` |
| `discord.ready` | `outcome` | `ready.js` |
| `discord.deploy_commands` | `outcome` | `deploy-commands.js` |
| `discord.reset.executed` | `scope`, `outcome` | `reset.js` |

**Gauges (`recordGauge`)**

| Metric | Attributes | Source |
| :--- | :--- | :--- |
| `discord.channel.queue_depth` | `provider` | `messageCreate.js` |

**Distributions (`recordDistribution`)**

| Metric | Unit | Source |
| :--- | :--- | :--- |
| `ai.generate.duration_ms` | ms | `aiService.js` |
| `discord.message.processing_ms` | ms | `messageCreate.js` |
| `discord.message.response_chars` | — | `messageCreate.js` |
| `discord.command.duration_ms` | ms | `index.js` |
| `discord.context_menu.duration_ms` | ms | `index.js` |
| `discord.deploy_commands.duration_ms` | ms | `deploy-commands.js` |
| `discord.reset.duration_ms` | ms | `reset.js` |
| `discord.ready.duration_ms` | ms | `ready.js` |

### Graceful shutdown

`closeSentry()` calls `Sentry.close(2000)` on process shutdown (see `index.js` signal handlers) to flush pending events.

### Validating in Sentry

After deploying with `SENTRY_DSN` set:

1. **Issues** — trigger a handled error or exercise error paths (e.g. `/reset` without permission).
2. **Performance** — mention the bot and inspect spans for message handling and `ai.generate`.
3. **Logs** — confirm structured lines when `SENTRY_ENABLE_LOGS` is true.
4. **Metrics** — filter by names above (e.g. `discord.message.received`).

---

## Development

### Prerequisites

- **Node.js 24.x** (matches CI and the Docker image)
- **pnpm 10.28** via [Corepack](https://nodejs.org/api/corepack.html)
- Optional: [Doppler CLI](https://docs.doppler.com/docs/cli) for local secrets

### Install and run

```bash
corepack enable
pnpm install --frozen-lockfile
```

With Doppler:

```bash
pnpm dev                 # nodemon + Doppler
pnpm start               # deploy slash commands + start bot (Doppler)
pnpm commands:deploy     # deploy slash commands only
pnpm predeploy           # test + deploy commands
```

### Testing

```bash
pnpm test                      # full Jest suite (CI runs this)
pnpm test:coverage             # coverage report in coverage/
pnpm test:coverage:check       # 100% coverage gate (local / maintainer)
```

- Tests live under [`test/`](test/) with shared setup in [`test/jest.setup.cjs`](test/jest.setup.cjs) and [`test/jest.afterEnv.cjs`](test/jest.afterEnv.cjs), which stub Discord, AI SDKs, and Sentry.
- Coverage thresholds (lines, branches, functions, statements) are **100%** in [`jest.config.cjs`](jest.config.cjs).
- **CI does not upload coverage** — only `pnpm test` runs in GitHub Actions.
- On Windows, run coverage commands directly in PowerShell without piping output; piping can cause Jest to hang.

### Maintainer scripts

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `audit:logs` | `pnpm audit:logs` | Enforce log message style (no stray colons; terminal punctuation) |

### Static analysis

The project is monitored on [DeepScan](https://deepscan.io/dashboard#view=project&tid=29402&pid=31349&bid=1015181) (badge above).

---

## CI and Docker

### GitHub Actions

| Workflow | Branch | Actions |
| :--- | :--- | :--- |
| [`build-docker.yml`](.github/workflows/build-docker.yml) | `main` | `pnpm test`, `pnpm audit`, Trivy FS + image scan, build and push `ghcr.io/<owner>/ai` |
| [`build-dev-docker.yml`](.github/workflows/build-dev-docker.yml) | `dev` | Same pipeline for the dev branch image |

Images are published to **GitHub Container Registry** as `ghcr.io/doubleangels/ai:latest` on the default branch.

### Docker image contents

[`.dockerignore`](.dockerignore) excludes from the build context:

- `test/`, `jest.config.cjs`, `coverage/`, `*.lcov`, `.nyc_output/`
- Documentation, CI configs, and dev tooling

The runtime stage contains application code and production dependencies only (`pnpm install --prod --frozen-lockfile` in the builder). The image runs as user `discordbot` (UID 1001), includes `dumb-init` and the Doppler CLI, and exposes a health check on the Node process.

---

## Project layout

| Path | Purpose |
| :--- | :--- |
| `index.js` | Discord client bootstrap, interaction handlers, shutdown |
| `config.js` | Environment-driven configuration and model validation |
| `instrument.js` | Sentry initialization, spans, metrics, `captureError` |
| `logger.js` | Pino logging with optional Sentry log forwarding |
| `deploy-commands.js` | Slash command registration with Discord REST API |
| `events/` | Discord event handlers (`messageCreate`, `ready`) |
| `commands/` | Slash commands (`reset`) |
| `utils/aiService.js` | OpenAI, Gemini, and Claude response generation |
| `utils/aiUtils.js` | Message splitting, vision download, history trimming, error classification |
| `utils/replyChainTracer.js` | Reply-chain traversal and message LRU cache |
| `scripts/audit-log-messages.js` | Log message style audit (maintainer) |
| `test/` | Jest suite (not shipped in Docker images) |
| `Dockerfile` | Multi-stage production image (Node 24 Alpine) |
| `docker-compose.yml` | Example production compose stack |

<br>
<div align="center">
  <sub>Built with Node.js 24 and Discord.js 14</sub>
</div>
