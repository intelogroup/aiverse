# neon-backup-job

Daily self-managed backup of the production Neon database: `pg_dump -Fc`
against `DATABASE_URL_DIRECT`, uploaded to Cloudflare R2 bucket
`verse-assets` under `backups/neon/`, with timestamp-based retention
(newest backup of each of the 7 most recent backup-days + of each of the
4 most recent ISO backup-weeks). Independent of Neon's 6-hour PITR
window. Runs as a Render cron job, daily 08:00 UTC.

| File | What |
|---|---|
| `backup.ts` | The job. Env-only config; see its header for the contract. Flags: `--dry-run`, `--prune-only`. |
| `backup.test.ts` | `bun test` — retention planner (incl. idempotence), ISO weeks, URL decomposition, and the SigV4 signer against the AWS documentation test vector. |
| `Dockerfile` | postgres:18-alpine + Bun. Context = this directory. In the repo it lands at `tools/neon-backup/`. |

Full design, evidence, and the exact Render creation steps:
`../NEON-BACKUP-JOB-REPORT.md`.

Env the cron service needs (names only): `DATABASE_URL_DIRECT`,
`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET` (= `verse-assets`).
