#!/bin/bash
set -e

# Retrieve secrets from Bitwarden and export them
# Replace the secret IDs below with your actual Bitwarden secret IDs
# Use jq '.value // ""' so JSON null becomes empty; empty uses default where shown
export AI_PROVIDER="$(v=$(bws secret get ca2456a9-366c-4096-ac9d-b3e501374eb9 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-openai}")"
export ANTHROPIC_API_KEY="$(bws secret get 1353220e-5248-47af-92ac-b3e5013d80b5 2>/dev/null | jq -r '.value // ""')"
export CLAUDE_MODEL_NAME="$(v=$(bws secret get c76a1f90-6f82-4f74-92bd-b3e5013d9c83 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-claude-haiku-4-5-20251001}")"
export DISCORD_BOT_TOKEN="$(bws secret get f4ae7c23-49d6-4e84-9ab2-b3c9015e33a8 2>/dev/null | jq -r '.value // ""')"
export DISCORD_CLIENT_ID="$(bws secret get 6eeb91a0-d353-40ed-972e-b3c9015e5101 2>/dev/null | jq -r '.value // ""')"
export ENABLE_CONTEXT_CACHE="$(v=$(bws secret get fb1b7ab7-98f0-4636-aa51-b3f001891fac 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-false}")"
export ENABLE_GOOGLE_MAPS="$(v=$(bws secret get c4c48ec0-b03f-46de-b2f9-b3f001894be6 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-false}")"
export ENABLE_WEB_SEARCH="$(v=$(bws secret get 8255a51f-becc-4ffb-b890-b3e5018020ac 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-false}")"
export GEMINI_API_KEY="$(bws secret get 040ab025-5ab8-4818-905d-b3e50137fad2 2>/dev/null | jq -r '.value // ""')"
export GEMINI_CACHE_TTL_SECONDS="$(v=$(bws secret get 72321920-6ab9-4712-9486-b3f001897280 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-3600}")"
export GEMINI_MODEL_NAME="$(v=$(bws secret get 9b60afa3-5db8-470a-8c01-b3e501379a7a 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-gemini-2.5-flash}")"
export LOG_LEVEL="$(v=$(bws secret get 8d4bad36-599b-4de5-856a-b3c9015efb4e 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-info}")"
export MAX_HISTORY_LENGTH="$(v=$(bws secret get e957f841-7c04-4aea-9a6a-b3c9015ea3ad 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-20}")"
export MAX_OUTPUT_TOKENS="$(v=$(bws secret get 46d9763d-3f6b-4fd2-a17f-b3e501843298 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-1024}")"
export MODEL_NAME="$(v=$(bws secret get 93f40e94-f127-41da-990d-b3c9015e89f5 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-gpt-5-nano}")"
export OPENAI_API_KEY="$(bws secret get 2380da26-4120-4f9f-a8bc-b3c9015e7487 2>/dev/null | jq -r '.value // ""')"
export REASONING_EFFORT="$(v=$(bws secret get 19a9ee05-2b3f-419d-9d68-b3c9015ebeb8 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-none}")"
export RESPONSES_VERBOSITY="$(v=$(bws secret get fee44254-3ab6-4f94-a221-b3c9015ee682 2>/dev/null | jq -r '.value // ""' 2>/dev/null); echo "${v:-low}")"

exec "$@"
