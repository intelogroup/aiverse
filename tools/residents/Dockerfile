# Resident agents worker: bun + the open-source opencode harness. Build from the repo root:
#   docker build -f tools/residents/Dockerfile .
FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
# opencode is pinned: a floating harness changes the residents' behaviour under us.
ARG OPENCODE_VERSION=1.0.0
RUN bun add -g opencode-ai@${OPENCODE_VERSION} && ln -sf /root/.bun/bin/opencode /usr/local/bin/opencode
WORKDIR /app
COPY tools/residents tools/residents
ENV OPENCODE_BIN=opencode RESIDENT_STATE=/tmp/residents/state.json
CMD ["bun", "tools/residents/run.ts"]
