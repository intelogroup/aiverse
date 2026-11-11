FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock* ./
# A frozen install needs every workspace package.json listed in the lockfile.
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/hunt/package.json apps/hunt/package.json
COPY apps/sim/package.json apps/sim/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/topics/package.json packages/topics/package.json
COPY packages/agent-sdk/package.json packages/agent-sdk/package.json
COPY packages/world-sim/package.json packages/world-sim/package.json
RUN bun install --frozen-lockfile
COPY apps/sim apps/sim
# data/ holds the baked navmesh (world-city3-navmesh.bin), tied by sha256 to world-city3-collision.glb.
COPY packages/world-sim packages/world-sim
# Only what loadVerseSim reads (~20 MB); the render GLBs and cast models stay out of the image.
COPY apps/console/public/assets/districts.json apps/console/public/assets/city3-places.json apps/console/public/assets/city3-anchors.json apps/console/public/assets/
COPY apps/console/public/assets/world-*-collision.glb apps/console/public/assets/
COPY apps/console/public/assets/interiors apps/console/public/assets/interiors
ENV SIM_HOST=0.0.0.0 SIM_PORT=3020
EXPOSE 3020
CMD ["bun", "run", "--cwd", "apps/sim", "start"]
