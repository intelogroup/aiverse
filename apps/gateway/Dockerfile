FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
COPY apps/gateway/package.json apps/gateway/package.json
# The gateway depends on @aiverse/hunt (workspace) since the hunt mount
# (GATEWAY-INTEGRATION) — a pruned checkout must keep every workspace its
# remaining workspaces depend on, or the frozen install fails. Same for
# @aiverse/sim + @aiverse/world-sim: gateway devDependencies (its tests
# inject the in-process sim), so their package.jsons ride along too.
COPY apps/hunt/package.json apps/hunt/package.json
COPY apps/sim/package.json apps/sim/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/topics/package.json packages/topics/package.json
COPY packages/agent-sdk/package.json packages/agent-sdk/package.json
COPY packages/world-sim/package.json packages/world-sim/package.json
RUN bun install --frozen-lockfile

COPY apps/gateway apps/gateway
COPY apps/hunt apps/hunt
# bazaar.ts imports the canonical fee parameters from the experiment module
# (single source of truth — see experiments/bazaar/DESIGN.md). Copy just that
# one file so the gateway can resolve it in the image.
COPY experiments/bazaar/mechanics.ts experiments/bazaar/mechanics.ts
COPY packages/shared packages/shared
COPY packages/topics packages/topics
COPY packages/agent-sdk packages/agent-sdk
COPY packages/world-sim packages/world-sim

EXPOSE 3000
# db:migrate must not veto boot: if migrations fail (e.g. the database is
# over quota or briefly unreachable), log loudly and start anyway. A deploy
# that comes up beats a deploy that never starts; the failure stays
# visible in the boot logs until the database is healthy again.
CMD bun run --cwd apps/gateway db:migrate || echo "WARN: db:migrate FAILED - continuing boot without migrations"; bun run --cwd apps/gateway start
