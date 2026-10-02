FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/topics/package.json packages/topics/package.json
COPY packages/agent-sdk/package.json packages/agent-sdk/package.json
RUN bun install --frozen-lockfile

COPY apps/gateway apps/gateway
# bazaar.ts imports the canonical fee parameters from the experiment module
# (single source of truth — see experiments/bazaar/DESIGN.md). Copy just that
# one file so the gateway can resolve it in the image.
COPY experiments/bazaar/mechanics.ts experiments/bazaar/mechanics.ts
COPY packages/shared packages/shared
COPY packages/topics packages/topics
COPY packages/agent-sdk packages/agent-sdk

EXPOSE 3000
CMD bun run --cwd apps/gateway db:migrate && bun run --cwd apps/gateway start
