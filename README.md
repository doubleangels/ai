# AI Discord Bot

<div align="center">
  <img src="logo.png" alt="Logo" width="250">
</div>
<br>

A feature-rich Discord bot powered by OpenAI (ChatGPT), Google (Gemini), or Anthropic (Claude) models, designed to provide intelligent conversational capabilities with image analysis support right within your Discord server.

## 🚀 Quick Start

### Prerequisites

- [Discord Bot Token](https://discord.com/developers/applications) - Create a new application and bot
- [OpenAI](https://platform.openai.com/overview), [Gemini](https://aistudio.google.com/apikey), or [Anthropic](https://console.anthropic.com) API key - Depending on which provider you use
- [Sentry](https://sentry.io/) DSN - Optional observability for errors, logs, traces, metrics, and profiling
- [Doppler](https://www.doppler.com/) - For secure secret management at runtime
- Docker and Docker Compose

### Docker Deployment

1. **Set up Doppler:**

   - Create a [Doppler](https://www.doppler.com/) project and config (e.g. `dev`, `prd`)
   - Add the following secrets to your Doppler config:
     - **Required:** `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and one of: `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`
    - **Optional:** `AI_PROVIDER`, `ALLOWED_GUILD_IDS`, `OPENAI_MODEL_NAME`, `GEMINI_MODEL_NAME`, `CLAUDE_MODEL_NAME`, `SENTRY_DSN`, `LOG_LEVEL`, `MAX_HISTORY_LENGTH`, `MAX_HISTORY_TOKENS`, `REASONING_EFFORT`, `RESPONSES_VERBOSITY`, `ENABLE_WEB_SEARCH`, `ENABLE_GOOGLE_MAPS`, `ENABLE_CONTEXT_CACHE`, `USER_COOLDOWN_MS`, `CHANNEL_COOLDOWN_MS`, `MAX_PENDING_PER_CHANNEL`, `IMAGE_DOWNLOAD_TIMEOUT_MS`, `MAX_IMAGE_BYTES`, and others listed in Configuration below
   - Create a **service token** for the config and copy it (you will pass it as `DOPPLER_TOKEN`)

2. **Create a `docker-compose.yml` file:**

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
    tmpfs:
      - /tmp
```

3. **Set the Doppler token and deploy:**

```bash
export DOPPLER_TOKEN=your_doppler_service_token_here
docker compose up -d
```

## ⚙️ Configuration

### Doppler Setup

This bot uses [Doppler](https://www.doppler.com/) to inject secrets as environment variables at runtime. The container runs `doppler run -- ...` so all keys in your Doppler config are available to the app.

**Required:**

1. Create a Doppler project and config (e.g. `prd`).
2. Add your secrets in the Doppler dashboard (or CLI). At minimum: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`.
3. Generate a **service token** for that config and pass it when running the container as `DOPPLER_TOKEN` (e.g. in `docker-compose.yml` or your orchestration).

### Environment Variables

| Variable           | Description                                      | Required | Default | Example |
| ------------------ | ------------------------------------------------- | :------: | :-----: | ------- |
| `DOPPLER_TOKEN`   | Doppler service token for the project/config      |    ✅    |    -    | -       |
| `SENTRY_DSN` | Optional Sentry DSN for observability. | (none) |
| `SENTRY_TRACES_SAMPLE_RATE` | Tracing sample rate between `0` and `1`. | `1.0` |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | Profiling sample rate between `0` and `1`. | `1.0` |
| `SENTRY_PROFILE_LIFECYCLE` | Profiling lifecycle mode: `trace` or `manual`. | `trace` |
| `SENTRY_ENABLE_LOGS` | Set to `false` to disable Sentry logs. | `true` |
| `SENTRY_ENABLE_METRICS` | Set to `false` to disable Sentry metrics. | `true` |

All other variables below can be stored in Doppler (recommended) or set in `environment` in your `docker-compose.yml`. The app reads them after Doppler injects them at startup.

#### AI provider and models

| Variable | Description | Default |
| --- | --- | --- |
| `AI_PROVIDER` | Backend to use: `openai`, `gemini`, or `claude`. | `openai` |
| `ALLOWED_GUILD_IDS` | Optional. Comma-separated Discord server (guild) IDs. When set, the bot only responds to messages and slash commands in those servers (not DMs). Empty = all servers. Example (this deployment): `691991366615564388,1307236666989346837,1466443091249467638,1470484138120319039`. See [`.env.example`](.env.example). | (none) |
| `OPENAI_MODEL_NAME` | OpenAI model when `AI_PROVIDER=openai`. | `gpt-5-nano` |
| `GEMINI_MODEL_NAME` | Gemini model when `AI_PROVIDER=gemini`. Falls back to `OPENAI_MODEL_NAME` if unset. | `gemini-2.5-flash` |
| `CLAUDE_MODEL_NAME` | Claude model when `AI_PROVIDER=claude`. Falls back to `OPENAI_MODEL_NAME` if unset. | `claude-haiku-4-5-20251001` |

**OpenAI (Responses API, text + image, reasoning, verbosity, optional web search):**  
`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-chat-latest`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.2-pro`, `gpt-5-pro`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `o3`, `o4-mini`, `o3-pro`, `o3-mini`

**Gemini (text + image, search grounding, thinking):**  
`gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-flash-image`

**Claude (vision, extended thinking):**  
`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-haiku-4-5`, `claude-opus-4-6`, `claude-sonnet-4-5-20250929`, `claude-sonnet-4-5`, `claude-opus-4-5-20251101`, `claude-opus-4-5`, `claude-opus-4-1-20250805`

Set `OPENAI_API_KEY` for OpenAI; `GEMINI_API_KEY` for Gemini ([Google AI Studio](https://aistudio.google.com/apikey)); `ANTHROPIC_API_KEY` for Claude ([Anthropic Console](https://console.anthropic.com)).

#### Reasoning, verbosity, and search

| Variable | Description | Default |
| --- | --- | --- |
| `REASONING_EFFORT` | **OpenAI only.** Reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`. GPT-5.2 also supports `none`; GPT-5.2-pro supports `medium`, `high`, `xhigh`. | `none` |
| `RESPONSES_VERBOSITY` | **OpenAI GPT-5 only.** Response verbosity: `low`, `medium`, `high`. | `low` |
| `ENABLE_WEB_SEARCH` | **OpenAI and Gemini.** Set to `true` or `1` to enable web search (OpenAI built-in tool; Gemini Google Search grounding). On Gemini, cannot be combined with `ENABLE_GOOGLE_MAPS` in one request—if both are enabled, search grounding is used and Maps is skipped (see log warning). | off |
| `ENABLE_GOOGLE_MAPS` | **Gemini only.** Set to `true` or `1` to enable grounding with Google Maps (places, area summaries, location-aware answers). Cannot be combined with `ENABLE_WEB_SEARCH` on Gemini; turn off web search to use Maps. | off |

#### Optional tuning variables

| Variable | Description | Default |
| --- | --- | --- |
| `MAX_OUTPUT_TOKENS` | Max tokens per reply (all providers). Clamped 256–65536. Lower values reduce cost. The system prompt’s suggested reply length is derived from this (capped near Discord’s ~2000 character limit) so the model’s guidance matches the output budget. | `1024` |
| `MAX_HISTORY_TOKENS` | Rough token-estimated cap for stored per-channel conversation history (in addition to `MAX_HISTORY_LENGTH`). **`0` disables token trimming**—with only `MAX_HISTORY_LENGTH`, long user/assistant messages can still use many input tokens per request. For production cost control, set a budget (e.g. **12000–24000** for busy channels; lower for smaller models). | `0` |
| `USER_COOLDOWN_MS` | Minimum time between requests per user (basic anti-spam/cost control). | `4000` |
| `CHANNEL_COOLDOWN_MS` | Minimum time between requests per channel (reduces pile-ups). | `1500` |
| `MAX_PENDING_PER_CHANNEL` | Max queued requests per channel before the bot responds “busy”. | `3` |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | Timeout for downloading image attachments. | `8000` |
| `MAX_IMAGE_BYTES` | Max bytes downloaded per image attachment. | `6000000` |
| `OPENAI_TIMEOUT_MS` | **OpenAI only.** Request timeout in milliseconds (5000–300000). | `60000` |
| `OPENAI_MAX_RETRIES` | **OpenAI only.** Max retries for transient failures (0–5). | `2` |

**Context and cost tuning:** Set **`MAX_HISTORY_TOKENS`** to a positive value so older turns are dropped once estimated input tokens exceed the budget (see `trimConversationHistory` in code). Pair with **`MAX_HISTORY_LENGTH`** (message count cap). Replies to other messages are capped in length before being injected into the prompt (`[Replying to: …]`). Image attachments are downloaded in parallel.

#### Context caching

Reduces cost and latency by caching static prompt content. Single switch for all providers. Can be stored in Doppler or set in your environment.

| Variable | Description | Default |
| --- | --- | --- |
| `ENABLE_CONTEXT_CACHE` | Set to `true` or `1` to enable context/prompt caching for all providers. | `false` |
| `GEMINI_CACHE_TTL_SECONDS` | TTL for Gemini context cache (60–2073600). | `3600` |

#### Claude extended thinking

| Variable | Description | Default |
| --- | --- | --- |
| `CLAUDE_THINKING_BUDGET_TOKENS` | **Claude only.** Token budget for extended thinking on supported 4.5 models (0 = disabled, max 32000). | `0` |

#### Gemini safety

| Variable | Description | Default |
| --- | --- | --- |
| `GEMINI_SAFETY_SETTINGS` | **Gemini only.** JSON array of `{"category":"...","threshold":"..."}` to tune safety filters. Example: `[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_MEDIUM_AND_ABOVE"}]`. Unset = API defaults. | - |

## 🖼️ Image Analysis

The bot supports comprehensive image analysis when using vision-capable models:

- **Image Descriptions**: Get detailed descriptions of image content
- **Visual Q&A**: Ask questions about images and receive contextual answers
- **Multi-Modal Input**: Combine text and images in the same message
- **Automatic Detection**: Automatically processes image attachments

**Usage Examples:**

- Send an image with text: "What's in this image?"
- Ask follow-up questions about previously shared images
- Get analysis of charts, diagrams, or screenshots

## 💬 Conversation Features

### Multi-Channel Support

- Shared conversation history per channel, allowing multiple users to participate
- Context preservation across message exchanges from all users
- Automatic history management and cleanup
- Basic backpressure (per-channel queue limit) and cooldowns to reduce spam/cost

### Interaction Methods

- **Mentions**: `@AI What's the weather like?`
- **Replies**: Reply to any bot message to continue the conversation

### Safety Defaults

- The bot sends messages with mentions disabled (`allowedMentions: { parse: [] }`) to avoid accidental `@everyone` / role pings.
- Logs avoid printing full message contents and full model replies by default (metadata only).

## 🔧 Commands

### `/reset` (admin only)

Reset conversation history for a specific channel or all channels. Only users with the **Administrator** permission can see and use this command.

- **No channel specified**: Resets conversation history for all channels
- **Channel specified**: Resets conversation history for the selected channel only
