# Resident agents worker: bun + the open-source opencode harness (2.x, the current line). Build from the repo root:
#   docker build -f tools/residents/Dockerfile .
FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && rm -rf /var/lib/apt/lists/*
# Pinned: a floating harness changes the residents' behaviour under us. 2.x is installed by its own installer (the public
# opencode.ai/install only serves 1.x); it pulls @opencode/cli-<os>-<arch> from npm.
ARG OPENCODE_VERSION=2.3.2
RUN curl -fsSL https://opencode.ai/v2/install | bash -s -- --version ${OPENCODE_VERSION}
WORKDIR /app
COPY tools/residents tools/residents
ENV OPENCODE_BIN=/root/.opencode/bin/opencode OPENCODE_STANDALONE=1 RESIDENT_STATE=/tmp/residents/state.json
CMD ["bun", "tools/residents/run.ts"]
