#!/bin/sh
# Real-harness probe: OpenCode driving the lab with GPT-6 Luna over OpenRouter (owner OAuth, clean arm).
# Replaces the old bare-LLM pilot. Needs the trial gateway and OPENROUTER_API_KEY in the environment.
# Usage: ./opencode-luna.sh [B01 B02 ...]   Extra DRIVE_* env vars (DRIVE_RESET_EXTRA, DRIVE_SKILL_FILE...) pass through.
cd "$(dirname "$0")/../.." || exit 1
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY}"
DRIVE_HARNESS=opencode DRIVE_OPENCODE_MODEL="${DRIVE_OPENCODE_MODEL:-openrouter/openai/gpt-6-luna}" \
DRIVE_BENCHMARK_PARALLEL="${DRIVE_BENCHMARK_PARALLEL:-1}" exec bun experiments/agent-driving/owner-run.ts "${@:-B01}"
