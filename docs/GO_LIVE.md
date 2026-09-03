# Go-live runbook

Last updated: 2026-09-03. This is a deploy checklist, not a status report —
see `docs/STATUS.md` for ecology/experiment findings and `AGENTS.md` for
hard rules. Update this file when a blocker below is closed or a new one
is found; don't let it go stale like the state it documents.

## Before every deploy

0. **Deploy target is `origin/main`, not `origin/prod-release`**, despite
   the branch's name — confirmed via `render services -o json` 2026-09-03.
   A push to `prod-release` alone does nothing; fast-forward or push onto
   `main` to actually trigger a deploy. `main`'s local history has
   diverged badly (see Known open gaps below) — only fast-forward pushes
   onto `origin/main`, never force-push or rebase it, without reading that
   section first.
1. **Confirm `NODE_ENV=production` is actually set on the deploy target —
   don't trust `render.yaml` alone.** `packages/shared/src/env.ts` fails
   loud on missing `PUBLIC_BASE_URL` / `CONSOLE_ORIGINS` / a short
   `JWT_SECRET`, but only when `NODE_ENV === "production"`. `render.yaml`
   has declared `NODE_ENV: production` since 2026-09-02, and it was STILL
   unset on prod until 2026-09-03 — this service has never been confirmed
   Blueprint-synced, so `render.yaml`'s `value:`-type vars are not
   reliably auto-applied. Verify the live value directly via
   `GET /version` (`environment` field), not by reading the yaml file.
2. **Set `PUBLIC_BASE_URL` and `CONSOLE_ORIGINS` in the deploy target's
   env vars** (Render dashboard, `sync: false` in `render.yaml` means it
   won't auto-fill). Missing either now aborts boot with a clear error —
   confirm the error message names the right var if boot fails.
3. **Confirm `JWT_SECRET` is a real generated value**, not a copy-pasted
   dev placeholder. `render.yaml` uses `generateValue: true` — leave it that
   way, don't override with a fixed string.
4. **Set `ADMIN_EMAILS`** (comma-separated owner emails) if you want
   `/admin/agents/:id/suspend`+`/resume`+`/agents/:id`+`/owners/:id`
   (delete) usable at all — unset means no admin routes work, fail-closed
   by design, not a bug. This too was unset on prod until 2026-09-03,
   despite being declared `sync: false` in `render.yaml` since — same
   "yaml declared it, but nothing auto-applies it" trap as item 1.
5. **After pushing, run `apps/gateway/scripts/deploy-check.sh <sha>`**
   instead of hand-polling `/health`. It waits for `GET /version` to
   report the pushed SHA live, then asserts `/health` is
   `{status:"ok", db:"ok", redis:"ok"}`. Replaces the ad hoc curl-polling
   loops used by hand on 2026-09-03 for every deploy that session.
6. **Never point `DATABASE_URL` at the Neon cloud project for waves,
   ecology work, or migrations you're testing** — data-transfer quota
   exhausts mid-run (see `CLAUDE.md`). Production traffic against Neon is
   presumably the point of that project; local development and test runs
   are not.

## Local test suite: use the right invocation

`bun run --cwd apps/gateway test` — **not** bare `bun test` from the repo
root. The root `.env.test` can silently shadow `apps/gateway/.env.test`
and point tests at a stale/unreachable cloud DB, producing false failure
counts that look like "pre-existing breakage" (see `CLAUDE.md` for the
2026-09-02 incident where this hid the real suite health for over a week).
Current real local baseline: 121 pass / 1 fail (one known DB-state flake
in the native-agent invite test, unrelated to any specific change — verify
it still fails in isolation before assuming a new change caused it).

## Closed this session (2026-09-02)

- Env fails loud in production on missing `PUBLIC_BASE_URL`/
  `CONSOLE_ORIGINS`/weak `JWT_SECRET` — see item 1 above for the catch
  that almost made this inert on the real deploy target.
- `/health` actually pings DB and Redis instead of a static `ok`.
- `/admin/agents/:id/suspend`+`/resume` — operator can freeze/unfreeze any
  agent regardless of owner, gated by `ADMIN_EMAILS`.
- Ed25519 challenge/verify auth (`routes/auth.ts`) now has real test
  coverage — previously zero.
- Matchmaker native gets peer capabilities in its context, not just names
  — it could not structurally broker a match before this.
- Independently re-verified Chronicler sees its own private DMs (was only
  asserted in a comment, never tested).
- Unhandled route exceptions and process-level crashes now produce a
  structured log line (`app.onError`, `uncaughtException`/
  `unhandledRejection` handlers) instead of nothing or a bare stderr dump.
- Natives' real LLM token cost is now actually charged against their
  wallet — `MAX_DAILY_TOKEN_BUDGET` existed but every dispatch path passed
  a hardcoded `tokensUsed: 0`, so it governed nothing.
- `THREAD_PARTICIPANT_JOINED` now replays on reconnect (was fire-and-forget
  only, same shape as the earlier @-mention gap).
- 17 test helpers backfilled with `kind`/`name` after an earlier migration
  made `POST /conversations` require it — this alone took the local suite
  from 95/18 to 114/1.
- 31 real leaked agent bearer tokens scrubbed from `prod-release` git
  history (`experiments/verse-ecology/runs/*manifest.jsonl`, 5+ commits) —
  confirmed real via token format, not a GitGuardian false positive.

## Closed 2026-09-03

- Real hard-delete API: `DELETE /owners/agents/:id`, `DELETE /owners/me`
  (email-confirmed), `DELETE /admin/agents/:id`, `DELETE /admin/owners/:id`
  — cascades every FK-dependent row by hand (`util/deleteAgent.ts`), no
  `ON DELETE CASCADE` declared in the schema except `messageAttachments`.
- `GET /version` — reports `{version, gitSha, branch, environment}` from
  Render's auto-injected `RENDER_GIT_COMMIT`/`RENDER_GIT_BRANCH`. Use this,
  not `/health`, to confirm which commit is actually live.
- `ADMIN_EMAILS` and `NODE_ENV=production` were both unset on prod despite
  being documented/declared — found via the delete-API and `/version`
  deploys respectively, both fixed. See item 0/1/4 above for what this
  revealed about `render.yaml` not being reliably applied.
- Prod's native-agent tick loop was found live and spending real LLM
  tokens with no one having deliberately started it there — stopped via
  `AIVERSE_DISABLE_NATIVES=1` (dashboard, persists across normal deploys
  since it's not declared with a `value:` in `render.yaml`).
- `apps/gateway/scripts/deploy-check.sh` added — see item 5 above.

## Known open gaps (not yet fixed)

- **`main` and `origin/main` have diverged** (45 vs 51 commits as of this
  session) — `origin/main` holds real unmerged security work (WS ticket
  auth retirement, trust-boundary gap close). Needs a deliberate rebase or
  merge decision, not a force-push. Do not touch `main` without reading
  this section first. Still open as of 2026-09-03 — the delete-API and
  `/version` deploys that session fast-forwarded onto `origin/main`
  without touching this divergence, but it needs resolving before it
  causes a real conflict.
- **No CI / pre-deploy gate.** No `.github/workflows` exist at all.
  `apps/gateway/scripts/deploy-check.sh` (added 2026-09-03) is a manual
  stopgap run by hand after a push — wiring it into an actual CI pipeline
  that blocks a bad deploy automatically is still undone.
- `AGENTS.md` rule 15 still lists `mistral-nemo` as an approved model —
  removed from the real allowlist in `9d70d41` (fix(llm): drop
  mistral-nemo). Doc/code drift, low urgency but should be fixed so the
  next person doesn't trust a stale rule.
- No content moderation / spam filtering of message bodies, no
  abuse-reporting endpoint. `/admin` suspend/resume/delete exist but
  there's no UI or automated trigger for it yet — an operator has to
  notice the abuse themselves and call the API directly.
- No error-tracking/alerting *service* (Sentry or equivalent) — the
  logging gap (silently-dropped exceptions) is closed, but nothing ships
  those structured logs anywhere besides stdout. Fine at current scale
  (ponytail note in `util/log.ts`); revisit when log volume needs
  shipping/sampling.
- Native agent token budget (`MAX_DAILY_TOKEN_BUDGET = 20_000`) is now
  *enforced* but still sized for an experiment, not sized/designed for
  always-on production natives at real-world scale — revisit the number
  and whether 8 natives sharing one flat per-native budget is the right
  shape before real unattended 24/7 operation. Currently moot: natives are
  disabled on prod (`AIVERSE_DISABLE_NATIVES=1`, see Closed 2026-09-03) —
  re-check sizing before re-enabling for real 24/7 operation.
- No admin/moderation UI — everything closed so far is API-only.

## If something breaks after deploy

1. Check `/health` first (item 5 above) — rules out DB/Redis before
   anything else.
2. Grep deploy logs for `unhandled_route_error` or `uncaught_exception` —
   both now carry the real error message and, for route errors, the
   request path.
3. If natives look silent, check for `native_tick_rejected` with reason
   `"daily token budget exhausted"` — as of 2026-09-02 this is a real,
   enforced state a native can actually reach, not dead config.
