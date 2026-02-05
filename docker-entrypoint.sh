#!/bin/bash
set -e

# Retrieve secrets from Bitwarden and export them
# Replace the secret IDs below with your actual Bitwarden secret IDs
# Use jq '.value // ""' so JSON null becomes empty; then treat empty as unset (use default where applicable)
AI_PROVIDER=$(bws secret get ca2456a9-366c-4096-ac9d-b3e501374eb9 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export AI_PROVIDER="${AI_PROVIDER:-openai}"

export ANTHROPIC_API_KEY=$(bws secret get 1353220e-5248-47af-92ac-b3e5013d80b5 2>/dev/null | jq -r '.value // ""')
CLAUDE_MODEL_NAME=$(bws secret get c76a1f90-6f82-4f74-92bd-b3e5013d9c83 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export CLAUDE_MODEL_NAME="${CLAUDE_MODEL_NAME:-claude-haiku-4-5-20251001}"
export DISCORD_BOT_TOKEN=$(bws secret get f4ae7c23-49d6-4e84-9ab2-b3c9015e33a8 2>/dev/null | jq -r '.value // ""')
export DISCORD_CLIENT_ID=$(bws secret get 6eeb91a0-d353-40ed-972e-b3c9015e5101 2>/dev/null | jq -r '.value // ""')
ENABLE_WEB_SEARCH=$(bws secret get 8255a51f-becc-4ffb-b890-b3e5018020ac 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export ENABLE_WEB_SEARCH="${ENABLE_WEB_SEARCH:-false}"
export GEMINI_API_KEY=$(bws secret get 040ab025-5ab8-4818-905d-b3e50137fad2 2>/dev/null | jq -r '.value // ""')
GEMINI_MODEL_NAME=$(bws secret get 9b60afa3-5db8-470a-8c01-b3e501379a7a 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export GEMINI_MODEL_NAME="${GEMINI_MODEL_NAME:-gemini-2.5-flash}"
LOG_LEVEL=$(bws secret get 8d4bad36-599b-4de5-856a-b3c9015efb4e 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export LOG_LEVEL="${LOG_LEVEL:-info}"
MAX_HISTORY_LENGTH=$(bws secret get e957f841-7c04-4aea-9a6a-b3c9015ea3ad 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export MAX_HISTORY_LENGTH="${MAX_HISTORY_LENGTH:-20}"
MAX_OUTPUT_TOKENS=$(bws secret get 46d9763d-3f6b-4fd2-a17f-b3e501843298 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export MAX_OUTPUT_TOKENS="${MAX_OUTPUT_TOKENS:-1024}"
MODEL_NAME=$(bws secret get 93f40e94-f127-41da-990d-b3c9015e89f5 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export MODEL_NAME="${MODEL_NAME:-gpt-5-nano}"
export OPENAI_API_KEY=$(bws secret get 2380da26-4120-4f9f-a8bc-b3c9015e7487 2>/dev/null | jq -r '.value // ""')
REASONING_EFFORT=$(bws secret get 19a9ee05-2b3f-419d-9d68-b3c9015ebeb8 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export REASONING_EFFORT="${REASONING_EFFORT:-none}"
RESPONSES_VERBOSITY=$(bws secret get fee44254-3ab6-4f94-a221-b3c9015ee682 2>/dev/null | jq -r '.value // ""' 2>/dev/null)
export RESPONSES_VERBOSITY="${RESPONSES_VERBOSITY:-low}"
# Execute the command passed as arguments
exec "$@"
