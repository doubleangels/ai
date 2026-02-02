# AI Discord Bot

<div align="center">
  <img src="logo.png" alt="Logo" width="250">
</div>
<br>

A feature-rich Discord bot powered by OpenAI's AI models, designed to provide intelligent conversational capabilities with image analysis support right within your Discord server.

## 🚀 Quick Start

### Prerequisites

- [Discord Bot Token](https://discord.com/developers/applications) - Create a new application and bot
- [OpenAI API Key](https://platform.openai.com/overview) - Get your API key from OpenAI
- [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) - For secure secret management
- Docker and Docker Compose

### Docker Deployment

1. **Set up Bitwarden Secrets Manager:**

   - Create secrets in your Bitwarden Secrets Manager project for:
     - `DISCORD_BOT_TOKEN`
     - `DISCORD_CLIENT_ID`
     - `OPENAI_API_KEY`
     - Optionally: `LOG_LEVEL`, `MAX_HISTORY_LENGTH`, `MAX_HISTORY_TOKENS`, `MODEL_NAME`, `REASONING_EFFORT`, `RESPONSES_VERBOSITY`, `USER_COOLDOWN_MS`, `CHANNEL_COOLDOWN_MS`, `MAX_PENDING_PER_CHANNEL`, `IMAGE_DOWNLOAD_TIMEOUT_MS`, `MAX_IMAGE_BYTES`
   - Note the secret IDs for each secret
   - Update `docker-entrypoint.sh` with your actual Bitwarden secret IDs

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
      - BWS_ACCESS_TOKEN=${BWS_ACCESS_TOKEN}
    tmpfs:
      - /tmp
```

3. **Set the BWS access token and deploy:**

```bash
export BWS_ACCESS_TOKEN=your_bws_access_token_here
docker-compose up -d
```

## ⚙️ Configuration

### Bitwarden Secrets Manager Setup

This bot uses [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) (BWS) to securely manage secrets. Secrets are retrieved at container startup via the `docker-entrypoint.sh` script.

**Required Steps:**

1. Create secrets in your Bitwarden Secrets Manager project
2. Update `docker-entrypoint.sh` with your actual Bitwarden secret IDs
3. Set the `BWS_ACCESS_TOKEN` environment variable when running the container

### Environment Variables

The following environment variables can be set in your `docker-compose.yml`:

| Variable           | Description                                | Required | Default | Example |
| ------------------ | ------------------------------------------ | :------: | :-----: | ------- |
| `BWS_ACCESS_TOKEN` | Access token for Bitwarden Secrets Manager |    ✅    |    -    | -       |

**Note:** Most secrets and API keys are retrieved from Bitwarden Secrets Manager during container startup (via `docker-entrypoint.sh`). You must provide `BWS_ACCESS_TOKEN` for the bot to access these secrets. By default, this repository’s `docker-entrypoint.sh` retrieves:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `LOG_LEVEL`
- `MAX_HISTORY_LENGTH`
- `MODEL_NAME`
- `OPENAI_API_KEY`
- `REASONING_EFFORT`
- `RESPONSES_VERBOSITY`

You can either:
- Add additional `bws secret get ...` lines to `docker-entrypoint.sh` to retrieve more optional settings from Bitwarden, **or**
- Provide optional settings as normal environment variables in your `docker-compose.yml` (recommended for non-sensitive tuning knobs).

#### Optional tuning variables

| Variable | Description | Default |
| --- | --- | --- |
| `MAX_HISTORY_TOKENS` | Rough token-estimated cap for stored per-channel conversation history (in addition to `MAX_HISTORY_LENGTH`). `0` disables token trimming. | `0` |
| `USER_COOLDOWN_MS` | Minimum time between requests per user (basic anti-spam/cost control). | `4000` |
| `CHANNEL_COOLDOWN_MS` | Minimum time between requests per channel (reduces pile-ups). | `1500` |
| `MAX_PENDING_PER_CHANNEL` | Max queued requests per channel before the bot responds “busy”. | `3` |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | Timeout for downloading image attachments. | `8000` |
| `MAX_IMAGE_BYTES` | Max bytes downloaded per image attachment. | `6000000` |

### Supported Models

- `gpt-5`
- `gpt-5-nano`
- `gpt-5-mini`

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

### `/reset`

Reset conversation history for a specific channel or all channels.

- **No channel specified**: Resets conversation history for all channels
- **Channel specified**: Resets conversation history for the selected channel only
