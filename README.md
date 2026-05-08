<div align="center">
  <img src="https://raw.githubusercontent.com/doubleangels/ai/main/logo.png" alt="Logo" width="200" style="border-radius: 20px; margin-bottom: 20px;">
  
  <h1>🤖 AI Discord Bot</h1>
  <p><b>A highly advanced, multi-provider AI Discord assistant powered by OpenAI, Google Gemini, and Anthropic Claude.</b></p>
  
  [![Node.js Version](https://img.shields.io/badge/node.js-22.x-brightgreen.svg?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
  [![Discord.js](https://img.shields.io/badge/discord.js-14.x-blue.svg?style=flat-square&logo=discord)](https://discord.js.org/)
  [![Docker Support](https://img.shields.io/badge/docker-ready-2496ED.svg?style=flat-square&logo=docker)](https://www.docker.com/)
  [![Doppler](https://img.shields.io/badge/doppler-secrets-000000.svg?style=flat-square&logo=doppler)](https://www.doppler.com/)
  [![Sentry](https://img.shields.io/badge/sentry-observability-362D59.svg?style=flat-square&logo=sentry)](https://sentry.io/)
</div>

<hr>

## ✨ Key Features

- **🌐 Multi-Model Flexibility:** Seamlessly switch between **OpenAI**, **Google (Gemini)**, and **Anthropic (Claude)**. Always use the best model for the job.
- **👁️ Vision & Multi-Modal:** Send images as attachments. The bot can describe them, answer visual Q&A, and analyze charts effortlessly.
- **💬 Shared Conversation History:** Maintains contextual memory per Discord channel, allowing multiple users to collaboratively converse in the same thread.
- **🧵 Smart Context Tracing:** Understands the Discord reply chain. Reply to old messages and the bot dynamically traces the correct context.
- **🔎 Real-Time Web Search & Maps:** Ground your prompts in reality with live web search (OpenAI & Gemini) and Google Maps API integration (Gemini).
- **⚡ Prompt Caching:** Drastically reduces costs and API latency for long conversations via built-in context caching.
- **🛡️ Safety & Anti-Spam:** Features robust per-user and per-channel cooldowns, queue limits (backpressure), and safe mention defaults (never accidentally pings `@everyone`!).
- **🪶 Memory Optimized for Docker:** Aggressively drops unneeded Discord caches, enforces V8 heap limits (`--max-old-space-size=256`), and automatically strips massive base64 image strings from history after AI processing to prevent OOM errors.
- **📊 Production-Ready Observability:** Deep integration with **Sentry** (traces, profiling, metrics) and structured **Pino** logging.
- **🔐 Secure Secrets Management:** Powered by **Doppler** for effortless, secure environment variable injection at runtime.

---

## 🚀 Quick Start

### 1. Prerequisites

- [Discord Developer Portal](https://discord.com/developers/applications): Create a new app, add a bot, and secure the **Token** and **Client ID**.
- **API Keys**: Get an API key from [OpenAI](https://platform.openai.com/), [Gemini](https://aistudio.google.com/apikey), or [Anthropic](https://console.anthropic.com/).
- [Doppler](https://www.doppler.com/): Create a free account for secure runtime secrets.
- **Docker & Docker Compose** installed on your host machine.

### 2. Configure Doppler

Create a Doppler project and add the following required secrets to your config (e.g., `prd` or `dev`):
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `OPENAI_API_KEY` (or `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` depending on your provider)

*Generate a Service Token for your Doppler config. You will use this token to securely boot the bot.*

### 3. Deploy with Docker Compose

Create a `docker-compose.yml` file:

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

Start the bot:
```bash
export DOPPLER_TOKEN="dp.st.config.your_token_here"
docker compose up -d
```

---

## ⚙️ Configuration Guide

The bot is heavily customizable. Add these optional keys to your Doppler environment to tweak its behavior.

### 🧠 AI Provider & Models

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AI_PROVIDER` | Choose your backend: `openai`, `gemini`, or `claude`. | `openai` |
| `OPENAI_MODEL_NAME` | Model to use when provider is OpenAI. | `gpt-5.4-nano` |
| `GEMINI_MODEL_NAME` | Model to use when provider is Gemini. | `gemini-3-flash-preview` |
| `CLAUDE_MODEL_NAME` | Model to use when provider is Claude. | `claude-sonnet-4-6` |
| `ALLOWED_GUILD_IDS` | Comma-separated list of allowed Discord Server IDs. Limits where the bot works. | *All Servers* |

### 🛠️ Advanced AI Settings

| Variable | Description | Default |
| :--- | :--- | :--- |
| `ENABLE_WEB_SEARCH` | `true` or `false`. Enables live internet search for OpenAI/Gemini. | `false` |
| `ENABLE_GOOGLE_MAPS`| `true` or `false`. Enables Google Maps grounding for Gemini. | `false` |
| `ENABLE_CONTEXT_CACHE` | `true` or `false`. Caches long prompt contexts to drastically save costs. | `false` |
| `REASONING_EFFORT` | `low`, `medium`, `high`. Configures OpenAI reasoning models (e.g. o1/o3/o4). | `none` |
| `RESPONSES_VERBOSITY` | `low`, `medium`, `high`. Dictates verbosity for supported models. | `low` |
| `CLAUDE_THINKING_BUDGET_TOKENS` | Token budget for extended reasoning on Claude 4.5+ models (0 = disabled). | `0` |

### 🛑 Conversation & Cost Limits

| Variable | Description | Default |
| :--- | :--- | :--- |
| `MAX_OUTPUT_TOKENS` | Hard cap on response tokens. Clamped between 256–65536. | `1024` |
| `MAX_HISTORY_TOKENS` | Token limit for channel history. Older messages drop off when this is reached. | `0` (Off) |
| `USER_COOLDOWN_MS` | Delay between requests per user (anti-spam feature). | `4000` |
| `CHANNEL_COOLDOWN_MS`| Delay between requests per channel. | `1500` |
| `MAX_PENDING_PER_CHANNEL` | Max requests queued before bot replies with "I'm busy". | `3` |

### 📈 Observability (Sentry)

If you wish to use Sentry for error tracking, add your `SENTRY_DSN` to Doppler.

| Variable | Description | Default |
| :--- | :--- | :--- |
| `SENTRY_DSN` | Your Sentry DSN endpoint. | *None* |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0` to `1.0` (Performance tracing capture rate). | `1.0` |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | `0.0` to `1.0` (Code profiling capture rate). | `1.0` |

---

## 🎮 Usage & Commands

### Interacting with the Bot
- **Mention the bot:** Start a prompt by pinging it: `@AI What is the capital of France?`
- **Reply to the bot:** Right-click a previous bot message and use Discord's native "Reply" feature to continue a thread seamlessly.
- *Note: The bot purposefully ignores `@here` and `@everyone` to prevent accidental spam.*

### Multi-Modal Image Analysis
Drag and drop an image into Discord, add a caption like `@AI describe this chart`, and hit send! The bot will automatically analyze and respond contextually.

### Admin Commands
- `/reset`: Clears the AI's short-term memory (conversation history). Can be scoped to the current channel or the entire server. *(Note: Only users with the **Administrator** permission can see and use this command).*

<br>
<div align="center">
  <sub>Built with ❤️ using Node.js and Discord.js</sub>
</div>
