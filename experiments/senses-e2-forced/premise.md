# Phase 0 Premise Check — AIVerse Agent-Senses Program

Checked 2026-11-14. Read-only against code and catalogs; the only live
calls made are itemized in §B.4. No credential value was read, printed,
or logged anywhere in this phase (cold-probe files were viewed with
token-shaped strings masked).

## A. World API surface — as proven by the cold-probe code

Source: `~/workspace/.build-tmp/cold-probe/probe.py` and `fly4.py`
(the drivers that flew a real agent on 2026-11-10/11). **Zero calls
were made to api.aiverse.network during Phase 0.**

- **Base URL:** `https://api.aiverse.network` (probe.py:6).
  fly4.py mounts the world API under it: `BASE =
  "https://api.aiverse.network/world"` (fly4.py:5).
- **Auth shape:** header `authorization: Bearer <agentToken>` plus
  `content-type: application/json` on every call (probe.py:25–27;
  fly4.py:9). The token comes from the registration response
  (probe.py:55), is stored by probe.py in a chmod-600 file
  (probe.py:58–60) and read back by fly4.py from its reg-response file
  (fly4.py:8) — "NEVER printed/logged" per fly4.py:2. This premise
  check followed the same rule.
- **Endpoints exercised by the probe code:**

  | Method & path | Where | Notes |
  |---|---|---|
  | POST `/agents/register` | probe.py:49–53 | No auth. Body `{name, capabilities, description}`. Response carries `agentToken`, `agentId`, claim fields (probe.py:55–63). |
  | POST `/world/body` | probe.py:66; fly4.py:52 | Attach a body (auth). |
  | GET `/world/observe` | probe.py:67; fly4.py:57 | Observation: body pose, nearest place, scene (run3-log.jsonl records). |
  | GET `/world/places` | probe.py:68 | Published places list (auth). |
  | GET `/world/map` | probe.py:69; fly4.py:45 (as `/map` under the `/world` base) | Returns `{places: [...]}`; fly4 looks up place id `shop-102` (fly4.py:47). |
  | POST `/world/act` | fly4.py:63 | Body `{id, action: {type: "go_to", place: "tea"}}`; act ids are client-chosen. |
  | GET `/world/act/{id}` | fly4.py:70–78 | Poll until terminal state ∈ {settled, failed, error, done, completed}. |
  | DELETE `/world/body` | fly4.py:86 | Detach. |

- **Run-log precedent:** fly4.py:12–15 appends one JSON record per call
  — `{run, ts, endpoint, method, status, outcome}` — to run3-log.jsonl.
  `harness/runlog.py` extends this shape per plan §2.
- **Injection points confirmed (plan §2):** the runner assembles each
  turn's prompt itself, so channel text is injected runner-side with no
  gateway/sim change; enforcement sits exactly on fly4.py's seam
  between choosing an action and POSTing `/act`.

## B. OpenRouter route — PREMISE FAILURE

### B.1 Method
Per `~/workspace/custom-connectors/custom.legacy-openrouter/CONNECTOR.md`:
stored credential `custom.openrouter`, attached only via
`dynamic_credentials.add_surrogate_to_request(req, "custom.openrouter",
allowed_hosts=["openrouter.ai"])`, responses read with
`read_json_response`; base `https://openrouter.ai/api/v1`. The
connector's own CLI (`bin/openrouter`) uses the identical pattern.

### B.2 What the live catalog says
`GET /api/v1/models` → HTTP 200, **234 models**. Searched every entry's
`id` and `name` (case-insensitive): **zero matches for "agnes"**, and no
Agnes vendor prefix exists in the catalog at all. The check was run
three ways (connector CLI list, connector CLI `--free` list, direct
surrogate fetch of the full JSON) with the same result.

### B.3 Verdict
**There is no Agnes 2.5 Flash model on OpenRouter to call.** Per the
Phase 0 stop rule, the single permitted live chat completion was **not**
made (there is no exact model id to make it to), and no substitute —
neither the direct Agnes API nor another model — was used. This
contradicts the assumption recorded in plan §11 (third-party
aggregators list an "Agnes 2.5 Flash," but OpenRouter's own live
catalog, the authoritative source for this route, does not carry it).
Route selection is a decision for Jim; it is not made here.

`harness/probe_route.py` encodes the correct behavior: resolve the id
from the live catalog at runtime, refuse (exit 2) if absent, otherwise
make exactly one completion (`"Reply with exactly: PROBE_OK"`,
max_tokens 16) and write the ledger entry. Its Phase 0 run output:

```json
{"premise_failure": true,
 "reason": "no Agnes 2.5 Flash model in the live OpenRouter catalog",
 "models_listed": 234, "chat_calls_made": 0, "ledger_entries_written": 0}
```

### B.4 Live calls made in Phase 0 (complete list)
- `GET https://openrouter.ai/api/v1/models` × 4 (CLI list, CLI
  `--free` list, direct surrogate fetch, probe_route.py run) — catalog
  reads; they return no `usage` object and are not billable model calls.
- Chat completions: **0**. Calls to api.aiverse.network: **0**.
- Accounted spend to date: **$0.000000**. `harness/ledger.jsonl` exists
  and is empty (0 bytes): ledger entry #1 is pending the first real
  probe, which probe_route.py will write the moment an Agnes 2.5 Flash
  id exists on the chosen route.
