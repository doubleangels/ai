<div align="center">
  <img src="https://raw.githubusercontent.com/doubleangels/ai/main/logo.png" alt="Logo" width="200" style="border-radius: 20px; margin-bottom: 20px;">

  <h1>AI Discord Bot</h1>
  <p><b>A multi-provider AI Discord assistant powered by OpenAI, Google Gemini, and Anthropic Claude.</b></p>

[![DeepScan grade](https://deepscan.io/api/teams/29402/projects/31349/branches/1015181/badge/grade.svg)](https://deepscan.io/dashboard#view=project&tid=29402&pid=31349&bid=1015181)
[![Node.js](https://img.shields.io/badge/node.js-26.x-brightgreen.svg?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
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
- **Slash chat** — `/chat` slash command with the same AI pipeline as @mentioning the bot (optional image attachment).
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

| Secret              | Purpose                                     |
| :------------------ | :------------------------------------------ |
| `DISCORD_BOT_TOKEN` | Bot token                                   |
| `DISCORD_CLIENT_ID` | Application ID (slash command registration) |
| `OPENAI_API_KEY`    | When `AI_PROVIDER=openai`                   |
| `GEMINI_API_KEY`    | When `AI_PROVIDER=gemini`                   |
| `ANTHROPIC_API_KEY` | When `AI_PROVIDER=claude`                   |

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

Set variables in Doppler, or copy [`.env.example`](.env.example) to `.env` for local experiments without Doppler. Invalid model names cause the process to exit at startup with a logged error.

### Discord and logging

| Variable            | Description                                                                                                                     | Default               |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------ | :-------------------- |
| `DISCORD_BOT_TOKEN` | Bot token                                                                                                                       | _required_            |
| `DISCORD_CLIENT_ID` | Application ID                                                                                                                  | _required for deploy_ |
| `ALLOWED_GUILD_IDS` | Comma-separated guild IDs. Empty = all guilds **and DMs**. Non-empty = listed guilds only (DMs blocked); the bot **leaves** any other server on startup and when it receives a message or slash command there. **Set in production.** | _all servers + DMs_   |
| `LOG_LEVEL`         | Pino log level                                                                                                                  | `info`                |

### AI provider and models

| Variable            | Description                                                                  | Default                  |
| :------------------ | :--------------------------------------------------------------------------- | :----------------------- |
| `AI_PROVIDER`       | `openai`, `gemini`, or `claude`                                              | `openai`                 |
| `OPENAI_MODEL_NAME` | OpenAI model (also fallback for other providers if their model env is unset) | `gpt-6-luna`             |
| `GEMINI_MODEL_NAME` | Gemini model                                                                 | `gemini-3-flash-preview` |
| `CLAUDE_MODEL_NAME` | Claude model                                                                 | `claude-sonnet-4-6`      |

Supported model IDs are validated in [`config.js`](config.js). Unsupported values exit the process.

Only **current** models are accepted: nothing deprecated, legacy, or shut down, per each provider's model and deprecation pages as of 2026-11-12. Revisit the lists in `config.js` when providers announce deprecations.

| Provider | Supported models |
| :------- | :--------------- |
| OpenAI | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.2`, `gpt-5.2-pro` |
| Gemini (chat) | `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-flash-lite` |
| Gemini (`/imagine`) | `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image` |
| Claude | `claude-fable-5-2`, `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-haiku-4-5` |

An unsupported chat model exits at startup; an unsupported `GEMINI_IMAGE_MODEL_NAME` falls back to `gemini-3.1-flash-image` with a warning.

**Per-model request adjustments** (from each provider's docs, so newer models don't reject requests):

- **OpenAI:** `REASONING_EFFORT` is raised to the model's minimum: `low` for `gpt-6-astra` and `gpt-6.1-sol`, and `medium` for the `-pro` models. An invalid value counts as `none`. With reasoning on, `max_output_tokens` gets 25,000 tokens of headroom, because reasoning tokens count against it. `prompt_cache_retention: 24h` is sent only to `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4` and `gpt-5.2`; newer models use their default 30-minute cache. `temperature` is never sent. The `-pro` models can take several minutes per request, so raise `OPENAI_TIMEOUT_MS` if you use them.
- **Gemini:** `temperature` is never sent (deprecated on Gemini 3+, ignored by Gemini 4). `maxOutputTokens` gets 8,192 tokens of headroom (capped at 32,768), because thinking tokens count against it. Gemini 4 models skip explicit context caching, which they reject. GIF images aren't a documented Gemini input type, so they're replaced with a short note. Requests never start or end on a model turn.
- **Claude:** requests never start with or end on an assistant turn (Claude requires a user turn first and rejects assistant prefill on 4.6+ models).

**Claude thinking:** Claude Haiku 4.5 thinks only when `CLAUDE_THINKING_BUDGET_TOKENS` > 0 (sent as `budget_tokens`). Claude 4.6–4.8 models use adaptive thinking when that variable is > 0 (the number only sizes `max_tokens` headroom). Claude 5 and Fable models always think adaptively; control their depth and cost with `CLAUDE_EFFORT` (`low` is a good fit for chat). Claude requests never send `temperature`: the API version used by Anthropic SDK 1.x (`2026-10-21`) rejects sampling parameters.

### Advanced AI settings

| Variable                        | Description                                                       | Default        |
| :------------------------------ | :------------------------------------------------------------------ | :------------- |
| `ENABLE_WEB_SEARCH`             | Live internet search (OpenAI/Gemini)                                | `false`        |
| `ENABLE_GOOGLE_MAPS`            | Google Maps grounding (Gemini)                                      | `false`        |
| `ENABLE_CONTEXT_CACHE`          | Provider context / prompt caching (see behavior notes)              | `true`         |
| `CLAUDE_CACHE_MIN_TOKENS`       | Estimated prompt size before Claude prompts are marked for caching (1024–200000) | `2048` |
| `GEMINI_CACHE_TTL_SECONDS`      | Gemini explicit cache TTL, seconds (60–2073600, i.e. up to 24 days) | `3600`         |
| `GEMINI_SAFETY_SETTINGS`        | JSON array of `{ category, threshold }` safety settings             | _API defaults_ |
| `REASONING_EFFORT`              | OpenAI reasoning: `none`, `low`, `medium`, `high`, `xhigh` (raised to the model's minimum) | `none` |
| `RESPONSES_VERBOSITY`           | OpenAI text verbosity: `low`, `medium`, `high`                      | `low`          |
| `CLAUDE_THINKING_BUDGET_TOKENS` | Claude thinking (`0` = off, max 32000); see **Claude thinking** above | `0`          |
| `CLAUDE_EFFORT`                 | Claude effort: `low`, `medium`, `high`, `xhigh`, `max` (mapped or dropped for models that don't support a level) | _model default_ |
| `OPENAI_TIMEOUT_MS`             | OpenAI client timeout (5000–300000)                                 | `60000`        |
| `OPENAI_MAX_RETRIES`            | OpenAI client retries (0–5)                                         | `2`            |
| `GEMINI_TIMEOUT_MS`             | Gemini request timeout (5000–300000)                                | `60000`        |
| `CLAUDE_TIMEOUT_MS`             | Claude request timeout (5000–300000)                                | `60000`        |

### Conversation and cost limits

| Variable                            | Description                                                                 | Default          |
| :---------------------------------- | :-------------------------------------------------------------------------- | :--------------- |
| `MAX_OUTPUT_TOKENS`                 | Response token cap (256–65536)                                              | `1024`           |
| `MAX_HISTORY_TOKENS`                | Channel history token cap (`0` = disabled)                                  | `0`              |
| `MAX_HISTORY_LENGTH`                | Max messages per channel (plus system); minimum `1`                         | `10`             |
| `USER_COOLDOWN_MS`                  | Per-user **per-channel** cooldown (`0` = disabled)                          | `4000`           |
| `SECONDARY_MODEL_NAME`              | Secondary model when the primary returns busy/overloaded errors             | _unset_          |
| `SECONDARY_AI_PROVIDER`             | Provider for `SECONDARY_MODEL_NAME`; auto-detected from model ID when unset | _auto_           |
| `TERTIARY_MODEL_NAME`               | Tertiary model (tried after the secondary model fails)                      | _unset_          |
| `TERTIARY_AI_PROVIDER`              | Provider for `TERTIARY_MODEL_NAME`; auto-detected when unset                | _auto_           |
| `DISCORD_SHARD_COUNT`               | Shard count (`auto`, `2`, …); omit or `1` for single process                | _single process_ |
| `CHANNEL_COOLDOWN_MS`               | Per-channel cooldown (`0` = disabled)                                       | `1500`           |
| `MAX_PENDING_PER_CHANNEL`           | Queue depth before a “busy” reply (`0` = disabled)                          | `3`              |
| `CONVERSATION_HISTORY_MAX_CHANNELS` | Max in-memory channel histories (LRU; `0` = no cap; 0–10000)                | `500`             |
| `CONVERSATION_HISTORY_IDLE_MS`      | Drop idle channel history (`0` = disabled; max 604800000, i.e. 7 days)      | `86400000` (24h)  |

### Performance and memory

| Variable                    | Description                                              | Default            | Range          |
| :-------------------------- | :------------------------------------------------------- | :----------------- | :------------- |
| `MAX_REPLY_CHAIN_DEPTH`     | Parent messages to fetch when tracing a reply chain      | `15`               | 1–50           |
| `MESSAGE_CACHE_MAX_SIZE`    | LRU cache size for reply-chain message fetches           | `500`              | 10–10000       |
| `MESSAGE_CACHE_TTL_MS`      | Message cache TTL (ms)                                   | `1800000` (30 min) | 60000–86400000 |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | Vision image download timeout                            | `8000`             | —              |
| `MAX_IMAGE_BYTES`           | Max bytes per downloaded image                           | `6000000`          | —              |
| `MAX_IMAGE_DIMENSION`       | Long-side pixel cap for images sent to vision models, resized by Discord's media proxy (`0` = off) | `1024` | 256–4096 |
| `MAX_REPLY_CHAIN_IMAGES`    | Max images/GIFs collected from a reply chain per request | `4`                | 1–10           |

### Image generation (`/imagine`)

| Variable                            | Description                                                                                               | Default                  |
| :---------------------------------- | :-------------------------------------------------------------------------------------------------------- | :----------------------- |
| `GEMINI_API_KEY`                    | API key from [Google AI Studio](https://aistudio.google.com/apikey) (also used when `AI_PROVIDER=gemini`) | _unset_                  |
| `GEMINI_IMAGE_MODEL_NAME`           | Gemini Image model for `/imagine`                                                                         | `gemini-3.1-flash-image` |
| `SECONDARY_GEMINI_IMAGE_MODEL_NAME` | Backup Gemini Image model when the primary is rate-limited or unavailable                                 | _unset_                  |
| `IMAGE_GENERATION_TIMEOUT_MS`       | Image request timeout (10000–300000)                                                                      | `120000`                 |
| `IMAGE_USER_COOLDOWN_MS`            | Per-user per-channel cooldown for `/imagine` (`0` = disabled)                                             | `30000`                  |

The bot starts without `GEMINI_API_KEY`; `/imagine` is disabled until the key is set (same key as Gemini chat when using `AI_PROVIDER=gemini`). Set `SECONDARY_GEMINI_IMAGE_MODEL_NAME` (e.g. `gemini-2.5-flash-image`) to retry `/imagine` on rate limits or server errors.

**Behavior notes:**

- When you **reply** to the bot, quoted text from the reply chain (up to 2,000 characters) is prepended to your message **in addition to** stored `conversationHistory` (useful for translation and thread grounding). Only that request gets the full quote; stored history keeps a 300-character excerpt so later turns don't pay for it again.
- **Images and GIFs** (attachments and embed previews) come from your message and the nearest earlier non-bot message in the reply chain, up to `MAX_REPLY_CHAIN_IMAGES`. Images from older turns were already sent and are not re-billed. Large images are downscaled to `MAX_IMAGE_DIMENSION` before upload. Video attachments are not analyzed.
- Set `MAX_HISTORY_TOKENS` in production for long threads to cap API payload size (it is off by default).
- With `ENABLE_CONTEXT_CACHE=true` (default): **OpenAI** caches repeated prefixes automatically and the bot sends a stable `prompt_cache_key`. **Claude** gets one cache breakpoint before the latest user turn, but only once the prompt is estimated at `CLAUDE_CACHE_MIN_TOKENS` or more, because cache writes cost 1.25x input and expire after 5 minutes. **Gemini** explicit caches are created only when the system prompt reaches 1,024 tokens (the built-in prompt is ~200 tokens, so in practice Gemini's automatic implicit caching applies). Set `ENABLE_CONTEXT_CACHE=false` to disable.
- **Token usage** is logged per call (`AI token usage.`) with input, output, cached-input, cache-write and reasoning tokens, and recorded as `ai.tokens.*` metrics. Use these to check cache hit rates and cost per provider/model.
- **History staleness:** `conversationHistory` does not track Discord message IDs. Edited or deleted user messages may remain in memory until `/reset`, idle eviction, or token/length trimming. Deleting a **bot** reply removes the matching last assistant turn when content still matches.
- **SVG images** are excluded from vision (raster formats only). Gemini also can't analyze GIFs.
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

Chat with `/chat message:What is the capital of France?` instead of @mentioning the bot. Optional `image` attachment works like sending an image with a mention.

### Slash commands

| Command    | Description                                                             | Permission    |
| :--------- | :---------------------------------------------------------------------- | :------------ |
| `/chat`    | Chat with the bot (same as @mentioning it)                              | Everyone      |
| `/imagine` | Generate an image from a text prompt (Gemini Image)                     | Everyone      |
| `/reset`   | Clear history for a channel (including threads) or **this server only** | Administrator |

Slash commands are registered automatically when the bot starts (`index.js` calls `deploy-commands.js` before connecting). To deploy without starting the bot:

```bash
pnpm commands:deploy
```

---

## Observability

Set `SENTRY_DSN` in Doppler to enable Sentry. [`instrument.js`](instrument.js) loads **before** other application modules.

### Sentry environment variables

| Variable                             | Default                | Purpose                                                                              |
| :----------------------------------- | :---------------------- | :----------------------------------------------------------------------------------- |
| `SENTRY_DSN`                         | _unset_                 | Enable reporting                                                                     |
| `SENTRY_TRACES_SAMPLE_RATE`          | `0.1` prod / `1.0` dev  | Performance traces (`0.0`–`1.0`)                                                     |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | `0.1` prod / `1.0` dev  | Code profiling sample rate (`0.0`–`1.0`)                                             |
| `SENTRY_PROFILE_LIFECYCLE`           | `trace`                 | Profile lifecycle (e.g. `trace`, `manual`)                                           |
| `SENTRY_ENABLE_LOGS`                 | `true`                  | Forward Pino logs to Sentry (`false` drops them before sending)                      |
| `SENTRY_ENABLE_METRICS`              | `true`                  | Emit custom metrics (`false` skips them)                                             |
| `SENTRY_SEND_DEFAULT_PII`            | `false`                 | `true` enables Sentry's full default data collection (see below)                    |
| `NODE_ENV`                           | `production`            | Sentry environment tag; local variable capture is enabled only when not `production` |

"prod" means `NODE_ENV=production`, which is the Docker image default — set `SENTRY_TRACES_SAMPLE_RATE=1.0` explicitly if you want full sampling in production. Sample rates are clamped to `[0, 1]`; invalid values fall back to the default for the current environment.

**Data collection (Sentry SDK 11):** Sentry 11 replaced `sendDefaultPii` with `dataCollection` and collects broadly by default, **including AI prompts and responses** from its OpenAI, Anthropic and Google GenAI integrations. With `SENTRY_SEND_DEFAULT_PII` unset or `false`, [`instrument.js`](instrument.js) turns off user info, cookies, HTTP headers and bodies, and gen-AI/MCP inputs and outputs. Setting it to `true` uses Sentry's defaults, which send Discord users' messages and the bot's replies to Sentry.

Local variable capture on errors (`includeLocalVariables`) is enabled only outside production (`NODE_ENV` other than `production`). In Docker with `NODE_ENV=production` (the default), Sentry does not open the Node inspector, so container logs stay free of “Debugger listening on ws://…”.

### Errors

`captureError(error, tags)` from `instrument.js` attaches stringified tags and calls `captureException`. Used across startup (`index.js`), the Discord client (`bot.js`), configuration (`config.js`), command deploy (`deploy-commands.js`), AI generation (`aiService.js`, `geminiImageService.js`), chat handling (`channelChatHandler.js`, `messageCreate.js`), slash commands (`chat.js`, `imagine.js`, `reset.js`), and lifecycle events (`ready.js`, `messageDelete.js`).

### Performance spans

`startSpan(options, callback)` wraps async work. If `Sentry.startSpan` is unavailable, the callback runs directly.

| Span                       | Module                  | Purpose                                           |
| :------------------------- | :---------------------- | :------------------------------------------------ |
| Startup command deploy     | `index.js`              | Register slash commands before login              |
| Client login               | `bot.js`                | Discord gateway connection                        |
| Slash command handler      | `bot.js`                | Outer wrapper per `/chat`, `/imagine`, `/reset`   |
| Chat / mention AI response | `channelChatHandler.js` | End-to-end text chat (mentions, replies, `/chat`) |
| AI provider call           | `aiService.js`          | OpenAI / Gemini / Claude request                  |
| Gemini image generation    | `geminiImageService.js` | `/imagine` image API call                         |
| Command deploy             | `deploy-commands.js`    | Slash command registration                        |
| Client ready setup         | `ready.js`              | Post-login setup                                  |

Profiling uses `@sentry/profiling-node` when available; if the integration fails to load, the bot continues without profiling.

### Logs

[`logger.js`](logger.js) wraps Pino and forwards `info`, `warn`, `error`, `debug`, `trace`, and `fatal` to `Sentry.logger` when logs are enabled. Forwarding failures are swallowed and logged locally at debug level.

Set `LOG_LEVEL=debug` in development to see ignore/rejection reasons (disallowed guilds, messages without mentions, cooldown skips, and command validation failures).

**Structured logging conventions**

- Log messages use plain English with terminal punctuation (`.` `!` `?`). Context goes in the structured object, not in the message string.
- **`info`** — request lifecycle: command initiated/completed, chat request received, AI generation started, reply delivered, history reset.
- **`debug`** — skipped or rejected inputs, queue depth, history load/update, intermediate steps.
- **`warn`** — recoverable failures: cooldown replies, partial delivery, empty AI responses, backpressure.
- **`error`** — failures with `serializeError(...)` for stack traces; always paired with `captureError` where appropriate.

**Per-surface log flow**

| Surface          | Initiated                                           | In progress                         | Completed / outcome                                           |
| :--------------- | :-------------------------------------------------- | :---------------------------------- | :------------------------------------------------------------ |
| @mention / reply | `messageCreate.js` (gate) → `channelChatHandler.js` | Generating/sending AI response      | `Finished processing chat request.`                           |
| `/chat`          | `Chat command initiated.`                           | Same shared handler                 | `Chat command completed.`                                     |
| `/imagine`       | `Imagine command initiated.`                        | `geminiImageService.js`             | `Imagine command completed.` (+ image bytes/model on success) |
| `/reset`         | `Reset command initiated.`                          | Channel/guild lock + history delete | `Reset command completed.`                                    |
| Slash wrapper    | `bot.js` `Executing command.`                       | Command `execute()`                 | `Command executed successfully.`                              |
| Startup          | `deploy-commands.js`                                | —                                   | `Slash commands deployed on startup.`                         |

### Custom metrics

Metrics are no-ops when Sentry is disabled or metrics are turned off. Attributes are normalized (objects JSON-stringified; `null`/`undefined` dropped).

**Counters (`recordCount`)**

| Metric                             | Attributes                                          | Source                        |
| :--------------------------------- | :-------------------------------------------------- | :---------------------------- |
| `ai.generate.requests`             | `provider`, `outcome`                               | `aiService.js`                |
| `discord.message.received`         | `provider`, `trigger` (`mention`, `reply`, `slash`) | `channelChatHandler.js`       |
| `discord.message.responded`        | `provider`, `outcome`                               | `channelChatHandler.js`       |
| `discord.message.rejected`         | `reason`                                            | `messageCreate.js`, `chat.js` |
| `discord.command.executed`         | `command`, `outcome`                                | `bot.js`                      |
| `discord.command.chat`             | `outcome`                                           | `chat.js`                     |
| `discord.command.chat.rejected`    | `reason`                                            | `chat.js`                     |
| `discord.command.imagine`          | `outcome`                                           | `imagine.js`                  |
| `discord.command.imagine.cooldown` | —                                                   | `imagine.js`                  |
| `discord.context_menu.executed`    | `command`, `outcome`                                | `bot.js`                      |
| `discord.api.failure`              | `location`, `httpStatus`, …                         | multiple                      |
| `discord.api.rate_limit`           | `location`, …                                       | multiple                      |
| `discord.login`                    | —                                                   | `index.js`                    |
| `discord.ready`                    | `outcome`                                           | `ready.js`                    |
| `discord.deploy_commands`          | `outcome`                                           | `deploy-commands.js`          |
| `discord.reset.executed`           | `scope`, `outcome`                                  | `reset.js`                    |

**Gauges (`recordGauge`)**

| Metric                        | Attributes | Source                  |
| :---------------------------- | :--------- | :---------------------- |
| `discord.channel.queue_depth` | `provider` | `channelChatHandler.js` |

**Distributions (`recordDistribution`)**

| Metric                                                        | Unit       | Source                  |
| :------------------------------------------------------------ | :--------- | :---------------------- |
| `ai.generate.duration_ms`                                     | ms         | `aiService.js`          |
| `ai.tokens.input` / `.output` / `.cached_input` / `.cache_write` / `.reasoning` | tokens (`provider`, `model`) | `aiService.js` |
| `discord.message.processing_ms`                               | ms         | `channelChatHandler.js` |
| `discord.message.response_chars`                              | —          | `channelChatHandler.js` |
| `discord.command.duration_ms`                                 | ms         | `bot.js`                |
| `discord.command.chat.duration_ms`                            | ms         | `chat.js`               |
| `discord.command.imagine.duration_ms`                         | ms         | `imagine.js`            |
| `discord.context_menu.duration_ms`                            | ms         | `bot.js`                |
| `gemini.image.success` / `.error` / `.filtered` / `.fallback` | `model`, … | `geminiImageService.js` |
| `gemini.image.duration_ms`                                    | ms         | `geminiImageService.js` |
| `discord.deploy_commands.duration_ms`                         | ms         | `deploy-commands.js`    |
| `discord.reset.duration_ms`                                   | ms         | `reset.js`              |
| `discord.ready.duration_ms`                                   | ms         | `ready.js`              |

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

- **Node.js 26.x** (matches CI and the Docker image; `>=24` is supported)
- **pnpm 12.18** (pinned in `package.json` `packageManager`). Node 25+ no longer bundles Corepack, so install pnpm with `npm install -g pnpm@12.18.0` (or `corepack enable` on Node 24)
- Optional: [Doppler CLI](https://docs.doppler.com/docs/cli) for local secrets

### Install and run

```bash
npm install -g pnpm@12.18.0   # or: corepack enable (Node 24 only)
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

| Script       | Command           | Purpose                                                           |
| :----------- | :---------------- | :---------------------------------------------------------------- |
| `audit:logs` | `pnpm audit:logs` | Enforce log message style (no stray colons; terminal punctuation) |

### Static analysis

The project is monitored on [DeepScan](https://deepscan.io/dashboard#view=project&tid=29402&pid=31349&bid=1015181) (badge above).

---

## CI and Docker

### GitHub Actions

| Workflow                                                         | Branch | Actions                                                                               |
| :--------------------------------------------------------------- | :----- | :------------------------------------------------------------------------------------ |
| [`build-docker.yml`](.github/workflows/build-docker.yml)         | `main` | `pnpm test`, `pnpm audit`, Trivy FS + image scan, build and push `ghcr.io/<owner>/ai` |
| [`build-dev-docker.yml`](.github/workflows/build-dev-docker.yml) | `dev`  | Same pipeline for the dev branch image                                                |

Images are published to **GitHub Container Registry** as `ghcr.io/doubleangels/ai:latest` on the default branch.

### Docker image contents

[`.dockerignore`](.dockerignore) excludes from the build context:

- `test/`, `jest.config.cjs`, `coverage/`, `*.lcov`, `.nyc_output/`
- Documentation, CI configs, and dev tooling

The runtime stage contains application code and production dependencies only (`pnpm install --prod --frozen-lockfile` in the builder). The image runs as user `discordbot` (UID 1001), includes `dumb-init` and the Doppler CLI, and exposes a health check on the Node process.

---

## Project layout

| Path                            | Purpose                                                                    |
| :------------------------------ | :------------------------------------------------------------------------- |
| `index.js`                      | Startup: deploy slash commands, then spawn shards or load `bot.js`         |
| `bot.js`                        | Discord client, command/event loading, slash interaction router            |
| `config.js`                     | Environment-driven configuration and model validation                      |
| `instrument.js`                 | Sentry initialization, spans, metrics, `captureError`                      |
| `logger.js`                     | Pino logging with optional Sentry log forwarding                           |
| `deploy-commands.js`            | Slash command registration with Discord REST API                           |
| `events/`                       | Discord event handlers (`messageCreate`, `messageDelete`, `ready`)         |
| `commands/`                     | Slash commands (`chat`, `imagine`, `reset`)                                |
| `utils/channelChatHandler.js`   | Shared chat pipeline for mentions, replies, and `/chat`                    |
| `utils/aiService.js`            | OpenAI, Gemini, and Claude response generation                             |
| `utils/geminiImageService.js`   | Gemini Image generation for `/imagine`                                     |
| `utils/aiUtils.js`              | Message splitting, vision download, history trimming, error classification |
| `utils/replyChainTracer.js`     | Reply-chain traversal and message LRU cache                                |
| `utils/discordApi.js`           | Discord REST call wrapper with retry/backoff on rate limits                |
| `utils/guildAccess.js`          | `ALLOWED_GUILD_IDS` enforcement; leaves disallowed guilds                  |
| `utils/imagineMessage.js`       | Detects bot-generated `/imagine` image posts for reply handling            |
| `utils/logSanitize.js`          | Redacts secrets (tokens, keys) from log and error output                   |
| `scripts/audit-log-messages.js` | Log message style audit (maintainer)                                       |
| `test/`                         | Jest suite (not shipped in Docker images)                                  |
| `Dockerfile`                    | Multi-stage production image (Node 26 Alpine)                              |
| `docker-compose.yml`            | Example production compose stack                                           |

<br>
<div align="center">
  <sub>Built with Node.js 26 and Discord.js 14</sub>
</div>
