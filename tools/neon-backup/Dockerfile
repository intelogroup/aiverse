# neon-backup cron image. Docker context = this directory.
#
# Base is postgres:18-alpine because it carries pg_dump/pg_restore 18.
# pg_dump refuses to dump a server NEWER than itself ("aborting because
# of server version mismatch"), and prod Neon runs PG 18 — the gateway's
# oven/bun image carries no pg tools at all, and an older client would
# fail on the first run. Bun is copied in from the official alpine image
# (musl build) to run backup.ts, matching the gateway's runtime.
FROM oven/bun:1-alpine AS bun
FROM postgres:18-alpine
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY backup.ts ./
# Render cron supplies the schedule; this CMD is the job's start command.
CMD ["bun", "run", "backup.ts"]
